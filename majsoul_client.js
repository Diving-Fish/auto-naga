// MajSoul gateway client: login over WebSocket + protobuf, fetch a paipu, decode to
// the { record, mjslog, matchmode_map_, fan_map_ } shape that paipu_transfer.js expects.
//
// This replaces the old Puppeteer-based scraping of in-page JS objects (GameMgr/net/cfg),
// which broke when MajSoul rewrote the web client as a Unity WebGL build (those globals
// no longer exist). The server-side gateway protocol is independent of the client engine,
// so we talk to it directly.

import protobuf from "protobufjs";
import { WebSocket } from "ws";
import crypto from "crypto";
import { randomUUID } from "crypto";
import fs from "fs";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RES_DIR = path.join(__dirname, "majsoul_res");

// The gateway rejects any login whose client_version_string is not the version currently
// deployed on the web client (error 151, "游戏版本过旧"), so it has to be read from the game
// page rather than pinned here -- this constant is only the fallback if that read fails.
const FALLBACK_CLIENT_VERSION = "4.0.46";
const GAME_PAGE_URL = "https://game.maj-soul.com/1/";
const routesUrl = (version) =>
    `https://route-5.maj-soul.com/api/clientgate/routes?platform=Web&version=${version}&lang=chs_t`;

const MSG_TYPE = { NOTIFY: 1, REQUEST: 2, RESPONSE: 3 };

function httpsText(url) {
    return new Promise((resolve, reject) => {
        https
            .get(url, (r) => {
                let buf = "";
                r.on("data", (d) => (buf += d));
                r.on("end", () => resolve(buf));
            })
            .on("error", reject);
    });
}

async function httpsJson(url) {
    const buf = await httpsText(url);
    try {
        return JSON.parse(buf);
    } catch (e) {
        throw new Error(`bad JSON from ${url}: ${buf.slice(0, 120)}`);
    }
}

// The Unity loader in the game page carries the deployed build number, both as the
// `productVersion` passed to createUnityInstance and in the Build/*.loader.js filename.
let _clientVersion = null;
async function getClientVersion() {
    if (_clientVersion) return _clientVersion;
    try {
        const html = await httpsText(GAME_PAGE_URL);
        const m = html.match(/productVersion:\s*"([\d.]+)"/) || html.match(/-release-([\d.]+)\(\d+\)\.loader\.js/);
        if (m) {
            _clientVersion = m[1];
            return _clientVersion;
        }
    } catch (e) { /* fall through to the pinned version */ }
    _clientVersion = FALLBACK_CLIENT_VERSION;
    return _clientVersion;
}

// Lazily loaded shared protobuf root + config maps (parsed once per process).
let _root = null;
let _configMaps = null;

function getRoot() {
    if (!_root) {
        const json = JSON.parse(fs.readFileSync(path.join(RES_DIR, "liqi.json")));
        // The live client sends a platform tag the shipped descriptor does not declare yet.
        json.nested.lq.nested.ReqRequestConnection.fields.platform = { type: "string", id: 6 };
        _root = protobuf.Root.fromJSON(json);
    }
    return _root;
}

// Parse lqc.lqbin (MajSoul config tables) into the maps paipu_transfer.js needs:
//   fan_map_       <- table "fan" sheet "fan"        (yaku id -> { name_jp, name_en, ... })
//   matchmode_map_ <- table "desktop" sheet "matchmode" (mode_id -> { room_name_jp, ... })
function getConfigMaps() {
    if (_configMaps) return _configMaps;
    const cfgRoot = protobuf.loadSync(path.join(RES_DIR, "config.proto"));
    const ConfigTables = cfgRoot.lookupType("lq.config.ConfigTables");
    const ct = ConfigTables.decode(fs.readFileSync(path.join(RES_DIR, "lqc.lqbin")));
    const PBTYPE = {
        uint32: "uint32", int32: "int32", string: "string", bool: "bool",
        float: "float", double: "double", int64: "int64", uint64: "uint64",
    };
    function buildMap(tableName, sheetName) {
        const table = ct.schemas.find((t) => t.name === tableName);
        const sheet = table.sheets.find((s) => s.name === sheetName);
        const Row = new protobuf.Type(`${tableName}_${sheetName}_Row`);
        for (const f of sheet.fields) {
            const t = PBTYPE[f.pbType] || "string";
            Row.add(f.arrayLength ? new protobuf.Field(f.fieldName, f.pbIndex, t, "repeated") : new protobuf.Field(f.fieldName, f.pbIndex, t));
        }
        const data = ct.datas.find((d) => d.table === tableName && d.sheet === sheetName);
        const key = (sheet.meta && sheet.meta.key) || "id";
        const map = {};
        for (const row of data.data) {
            const o = Row.toObject(Row.decode(row), { defaults: true });
            map[o[key]] = o;
        }
        return map;
    }
    _configMaps = { fan_map_: buildMap("fan", "fan"), matchmode_map_: buildMap("desktop", "matchmode") };
    return _configMaps;
}

class MajsoulConnection {
    constructor(endpoint) {
        this.endpoint = endpoint;
        this.root = getRoot();
        this.Wrapper = this.root.lookupType("lq.Wrapper");
        this.reqIndex = 0;
        this.pending = {};
        this.heartbeatTimer = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.endpoint, { perMessageDeflate: false });
            this.ws.binaryType = "arraybuffer";
            const onErr = (e) => reject(e);
            this.ws.on("open", () => {
                this.ws.removeListener("error", onErr);
                this.ws.on("error", (e) => this._failAll(e));
                this.ws.on("close", () => this._failAll(new Error("connection closed")));
                resolve();
            });
            this.ws.on("error", onErr);
            this.ws.on("message", (data) => this._onMessage(Buffer.from(data)));
        });
    }

    _onMessage(buf) {
        // RESPONSE frame: [0x03][idx lo][idx hi][Wrapper]; NOTIFY frames are ignored.
        if (buf[0] !== MSG_TYPE.RESPONSE) return;
        const index = buf[1] | (buf[2] << 8);
        const p = this.pending[index];
        if (!p) return;
        delete this.pending[index];
        try {
            const wrapper = this.Wrapper.decode(buf.slice(3));
            p.resolve(p.respType.toObject(p.respType.decode(wrapper.data), { defaults: true }));
        } catch (e) {
            p.reject(e);
        }
    }

    _failAll(err) {
        for (const k of Object.keys(this.pending)) {
            this.pending[k].reject(err);
            delete this.pending[k];
        }
    }

    // Call a Lobby RPC. Returns the decoded response object.
    rpc(methodName, reqTypeName, respTypeName, payload, timeoutMs = 20000) {
        return this.serviceRpc("Lobby", methodName, reqTypeName, respTypeName, payload, timeoutMs);
    }

    // Call an RPC on any gateway service (`Lobby`, `Route`, ...).
    serviceRpc(service, methodName, reqTypeName, respTypeName, payload, timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
            const ReqType = this.root.lookupType(reqTypeName);
            const RespType = this.root.lookupType(respTypeName);
            const reqBytes = ReqType.encode(ReqType.fromObject(payload)).finish();
            const wrapperBytes = this.Wrapper.encode(
                this.Wrapper.fromObject({ name: `.lq.${service}.${methodName}`, data: reqBytes })
            ).finish();
            const index = this.reqIndex++ % 60007;
            const frame = Buffer.concat([Buffer.from([MSG_TYPE.REQUEST, index & 0xff, (index >> 8) & 0xff]), wrapperBytes]);
            const timer = setTimeout(() => {
                if (this.pending[index]) {
                    delete this.pending[index];
                    reject(new Error(`rpc ${methodName} timeout`));
                }
            }, timeoutMs);
            this.pending[index] = {
                respType: RespType,
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            };
            this.ws.send(frame);
        });
    }

    // The gateway drops connections that stop sending .lq.Route.heartbeat, so a connection
    // that is parked between requests has to keep one going itself.
    startHeartbeat(intervalMs = 5000) {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.serviceRpc("Route", "heartbeat", "lq.ReqHeartbeat", "lq.ResHeartbeat", { platform: 11 })
                .catch(() => { /* a dead connection is noticed by the next real request */ });
        }, intervalMs);
        if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    close() {
        this.stopHeartbeat();
        if (this.ws) {
            try { this.ws.close(); } catch (e) { /* ignore */ }
            this.ws = null;
        }
    }
}

async function pickRoute(version) {
    const routesResp = await httpsJson(routesUrl(version));
    const routes = (routesResp.data.routes || []).filter((r) => r.ssl);
    if (routes.length === 0) throw new Error("no gateway routes available");
    return routes[Math.floor(Math.random() * routes.length)];
}

// Log in with account/password (HMAC-SHA256, key "lailai") and return a live connection.
async function loginConnection(username, password) {
    const version = await getClientVersion();
    const route = await pickRoute(version);
    const conn = new MajsoulConnection(`wss://${route.domain}/gateway`);
    await conn.connect();

    // The gateway now front-ends the lobby with a routing service: until the connection is
    // registered with .lq.Route.requestConnection every Lobby call is answered as if it came
    // from an outdated client (login -> 151, everything else -> 1004).
    const routeRes = await conn.serviceRpc("Route", "requestConnection", "lq.ReqRequestConnection", "lq.ResRequestConnection", {
        type: 1,
        route_id: route.id,
        timestamp: Math.floor(Date.now() / 1000),
        platform: "Web", // not in the shipped liqi.json; added in getRoot()
    });
    if (routeRes.error && routeRes.error.code) {
        conn.close();
        throw new Error(`majsoul route handshake failed: code ${routeRes.error.code}`);
    }

    const passHmac = crypto.createHmac("sha256", "lailai").update(password).digest("hex");
    const res = await conn.rpc("login", "lq.ReqLogin", "lq.ResLogin", {
        account: username,
        password: passHmac,
        device: { is_browser: true },
        random_key: randomUUID(),
        gen_access_token: true,
        client_version_string: `web-${version}`,
        currency_platforms: [2],
    });
    if (res.error && res.error.code) {
        conn.close();
        throw new Error(`majsoul login failed: code ${res.error.code} ${res.error.json_param || ""}`);
    }
    conn.startHeartbeat();
    return { conn, account_id: res.account_id, access_token: res.access_token };
}

// Fetch a paipu and decode it to the { record, mjslog, matchmode_map_, fan_map_ } shape.
// `paipuUuid` may be a full share string ("uuid_token") or a bare uuid.
async function fetchPaipuData(conn, paipuUuid) {
    const realUuid = String(paipuUuid).split("_")[0];
    const recRes = await conn.rpc("fetchGameRecord", "lq.ReqGameRecord", "lq.ResGameRecord", {
        game_uuid: realUuid,
        client_version_string: `web-${await getClientVersion()}`,
    });
    if (recRes.error && recRes.error.code) {
        throw new Error(`fetchGameRecord failed: code ${recRes.error.code}`);
    }
    if (!recRes.data || recRes.data.length === 0) {
        throw new Error("fetchGameRecord returned empty data");
    }

    const root = getRoot();
    const Wrapper = root.lookupType("lq.Wrapper");
    const detailWrapper = Wrapper.decode(recRes.data);
    const GameDetailRecords = root.lookupType("lq.GameDetailRecords");
    const details = GameDetailRecords.decode(detailWrapper.data);

    // Newer format stores actions[].result (wrapped records); older stores records[] directly.
    const rawActions = details.actions && details.actions.length
        ? details.actions.map((a) => a.result)
        : details.records || [];

    const mjslog = [];
    for (const bytes of rawActions) {
        if (!bytes || bytes.length === 0) continue;
        const w = Wrapper.decode(bytes);
        const typeName = w.name.replace(/^\.lq\./, ""); // ".lq.RecordDiscardTile" -> "RecordDiscardTile"
        const RecType = root.lookupType(`lq.${typeName}`);
        const obj = RecType.toObject(RecType.decode(w.data), { defaults: true });
        obj.cname = typeName; // paipu_transfer.js dispatches on e.cname
        mjslog.push(obj);
    }

    const { fan_map_, matchmode_map_ } = getConfigMaps();
    return { record: { head: recRes.head }, mjslog, matchmode_map_, fan_map_ };
}

export { loginConnection, fetchPaipuData, getConfigMaps };
