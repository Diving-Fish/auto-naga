import fs from "fs";

export class NagaUser {
    constructor(username, password, secret_md5, cookies) {
        this.username = username;
        this.password = password;
        this.secret_md5 = secret_md5;
        this.webPage = null;
        this.cookies = cookies || [];
        this.login = false;
    }
}

export class NagaUserGroup {
    constructor() {
        this.users = []
        if (fs.existsSync("naga_user.json")) {
            const value = fs.readFileSync("./naga_user.json").toString();
            const jsonData = JSON.parse(value);
            for (const value of jsonData) {
                this.users.push(new NagaUser(value.username, value.password, value.secret_md5, value.cookies));
            }
        }
        else {
            fs.writeFileSync("./naga_user.json", "[]");
        }
    }

    addUser(username, password, secret_md5) {
        const user = this.getByUsername(username);
        if (user !== undefined) throw new Error('User already exists');
        this.users.push(new NagaUser(username, password, secret_md5));
        this.save();
    }

    save() {
        const jsonData = [];
        for (const user of this.users) {
            jsonData.push({
                username: user.username,
                password: user.password,
                secret_md5: user.secret_md5,
                cookies: user.cookies
            });
        }
        fs.writeFileSync("./naga_user.json", JSON.stringify(jsonData));
    }

    getByUsername(username) {
        for (const user of this.users) {
            if (user.username === username) {
                return user;
            }
        }
    }

    getBySecret(secret_md5) {
        for (const user of this.users) {
            if (user.secret_md5 === secret_md5) {
                return user;
            }
        }
    }
}