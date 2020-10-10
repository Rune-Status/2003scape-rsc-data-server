const bcrypt = require('bcryptjs');
const log = require('bole')('player');
const promisify = require('util').promisify;
const sleep = require('sleep-promise');

const bcryptCompare = promisify(bcrypt.compare);
const bcryptHash = promisify(bcrypt.hash);

async function playerCount({ token }) {
    const queryHandler = this.server.queryHandler;
    const playerCount = await queryHandler.getPlayerCount();

    this.socket.sendMessage({
        token,
        count: playerCount
    });
}

async function playerOnlineCount({ token }) {
    this.socket.sendMessage({
        token,
        count: this.server.totalPlayers
    });
}

async function playerGetWorlds({ token, usernames }) {
    const usernameWorlds = {};

    for (const username of usernames) {
        usernameWorlds[username] = this.server.getPlayerWorld(username);
    }

    this.socket.sendMessage({ token, usernameWorlds });
}

async function playerLogin({ token, username, password, ip, reconnecting }) {
    const message = { token };

    if (!this.world) {
        log.warn(`${this} trying to login before connected to world`);
        message.code = 9;
        message.success = false;
        this.socket.sendMessage(message);
        return;
    }

    username = username.toLowerCase();

    const queryHandler = this.server.queryHandler;

    let { attempts, lastDate } = await queryHandler.getLoginAttempts(ip);

    if (attempts >= 5) {
        if ((Date.now() - lastDate) >= 1000 * 60 * 5) {
            await queryHandler.setLoginAttempts(ip, 0);
            attempts = 0;
        } else {
            message.code = 7;
            message.success = false;
            this.socket.sendMessage(message);
            return;
        }
    }

    await sleep(attempts * 1000);

    const hash = await queryHandler.getPlayerPassword(username);

    if (!hash || !(await bcryptCompare(password, hash))) {
        message.code = 3;
        message.success = false;
        await queryHandler.setLoginAttempts(ip, attempts + 1);
        return this.socket.sendMessage(message);
    }

    const rounds = bcrypt.getRounds(hash);
    const passwordHashRounds = this.server.config.passwordHashRounds;

    if (rounds < passwordHashRounds) {
        log.debug(
            `re-hashing ${username} password from ${rounds} rounds to ` +
            `${passwordHashRounds} rounds`
        );

        const newHash = await bcryptHash(password, passwordHashRounds);
        await queryHandler.setPlayerPassword(username, newHash);
    }

    const isLoggedIn = this.server.getPlayerWorld(username) !== 0;

    if (isLoggedIn) {
        message.code = 4;
        message.success = false;
        return this.socket.sendMessage(message);
    }

    const ipLoginCount = await queryHandler.getPlayerLoginCount(ip);

    if (ipLoginCount >= this.server.config.playersPerIP) {
        message.code = 6;
        message.success = false;
        return this.socket.sendMessage(message);
    }

    const banEndDate = await queryHandler.getPlayerBanEnd(username);

    if (banEndDate) {
        if (banEndDate > Date.now()) {
            message.code = 11;
            message.success = false;
            return this.socket.sendMessage(message);
        } else if (banEndDate === -1) {
            message.code = 12;
            message.success = false;
            return this.socket.sendMessage(message);
        } else {
            await queryHandler.setPlayerBan(username, 0);
            await playerLogin.bind(this, { token, username, password, ip })();
            return;
        }
    }

    if (this.world.members) {
        const membershipEndDate = await queryHandler.getPlayerMembershipEnd(
            username
        );

        if (membershipEndDate < Date.now()) {
            message.code = 15;
            message.success = false;
            return this.socket.sendMessage(message);
        }
    }

    const player = await queryHandler.getPlayer(username);
    await queryHandler.updatePlayerLogin(player.id, Date.now(), ip);

    message.success = true;
    message.player = player;

    if (reconnecting) {
        message.code = 1;
    } else {
        message.code = player.rank > 0 ? 25 : 0;
    }

    this.server.totalPlayers += 1;
    this.world.players.set(username, player.id);

    this.server.broadcastToWorlds({
        handler: 'playerLoggedIn',
        username: username
    });

    this.socket.sendMessage(message);
}

async function playerLogout({ token, username }) {
    username = username.toLowerCase();

    this.server.totalPlayers -= 1;
    this.world.players.remove(username);

    this.server.broadcastToWorlds({
        token,
        handler: 'playerLoggedOut',
        username
    });
}

async function playerRegister({ token, username, password, ip }) {
    const queryHandler = this.server.queryHandler;
    const message = { token };

    const ipLoginCount = await queryHandler.getPlayerLoginCount(ip);

    if (ipLoginCount >= this.server.config.playersPerIP) {
        message.code = 6;
        message.success = false;
        return this.socket.sendMessage(message);
    }

    const lastCreationDate = await queryHandler.lastCreationDate(ip);

    if (Date.now() - lastCreationDate < 1000 * 60 * 5) {
        message.code = 7;
        message.success = false;
        return this.socket.sendMessage(message);
    }

    if (await queryHandler.usernameExists(username)) {
        message.code = 3;
        message.success = false;
        return this.socket.sendMessage(message);
    }

    password = await bcryptHash(
        password,
        this.server.config.passwordHashRounds
    );

    await queryHandler.insertPlayer({ username, password, ip });

    message.code = 2;
    message.success = true;
    this.socket.sendMessage(message);

    log.info(`${this} registered player "${username}" from ${ip}`);

}

async function playerUpdate(player) {
    const queryHandler = this.server.queryHandler;
    const message = { token: player.token };

    delete player.token;
    await queryHandler.updatePlayer(player);

    message.success = true;
    this.socket.sendMessage(message);
}

async function playerMessage({
    token,
    toUsername,
    toWorld,
    fromUsername,
    message
}) {
    try {
        const world = this.server.worlds[toWorld];

        world.client.sendMessage({
            token,
            handler: 'playerMessage',
            toUsername,
            fromUsername,
            message
        });

        this.socket.sendMessage({
            token,
            success: true
        });
    } catch (e) {
        this.socket.sendMessage({
            token,
            error: 'invalid world',
            success: false
        });
    }
}

module.exports = {
    playerCount,
    playerGetWorlds,
    playerLogin,
    playerLogout,
    playerOnlineCount,
    playerRegister,
    playerUpdate,
    playerMessage
};
