import sqlite3 from 'sqlite3'
import {Database, open} from 'sqlite'
import fs from 'fs/promises'

/**
 * Class that handles database operations.
 */
export default class DB {
    private _dir = './db'

    constructor() {
        fs.access(this._dir)
            .then(() => console.log('DB directory exists'))
            .catch(() => {
                fs.mkdir(this._dir)
                    .then(() => console.log('DB directory created'))
                    .catch((err) => console.error('Unable to create DB directory', err))
            })
    }

    private _db: Database<sqlite3.Database> | undefined = undefined

    private async getDb(): Promise<Database<sqlite3.Database> | undefined> {
        if (!this._db) {
            this._db = await open({
                filename: `${this._dir}/steam_bot.db`,
                driver: sqlite3.Database
            })

            this._db.on('trace', (data) => {
                console.log('SQL Trace:', data)
            })

        }
        return this._db
    }

    // region Server Icons
    private async ensureSteamGameTable() {
        const db = await this.getDb()
        await db.exec('CREATE TABLE IF NOT EXISTS steam_games (id INTEGER PRIMARY KEY, app_id TEXT, date TEXT)')
    }

    /**
     * Will register a game as posted.
     * @param appId Steam app ID for the game.
     * @param date Date the game was posted.
     */
    async registerGameAsPosted(appId: string | number, date: string): Promise<boolean> {
        const db = await this.getDb()
        if (db) {
            await this.ensureSteamGameTable()
            const stmt = await db.prepare('INSERT INTO steam_games (app_id, date) VALUES (?,?)')
            const result = await stmt.run(appId, date)
            if (result.lastID) return true
        }
        return false
    }

    /**
     * Will return true if the game has already been posted.
     */
    async hasGameBeenPosted(appId: string | number): Promise<boolean> {
        const db = await this.getDb()
        if (db) {
            await this.ensureSteamGameTable()
            const result = await db.get('SELECT * FROM steam_games WHERE app_id = ?', appId)
            return !!result
        }
        return false
    }

    // endregion
}