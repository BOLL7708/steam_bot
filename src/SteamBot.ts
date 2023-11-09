import {CronJob} from 'cron'
import axios, {AxiosInstance} from 'axios'
import {WebhookClient} from 'discord.js'
import DB from './DB.js'
import Config from './Config.js'

export default class SteamBot {
    private _store: AxiosInstance
    private _db = new DB()

    async start() {
        console.log('SteamBot started.')
        const job = new CronJob('*/30 * * * *', async () => {
            await this.postGames(await this.fetchGameIds())
        })
        job.start()
    }

    // region Methods
    private ensureAPI() {
        if (!this._store) {
            this._store = axios.create({
                baseURL: 'https://store.steampowered.com',
                timeout: 60 * 1000,
                headers: {'Content-Type': 'application/json'},
                method: 'get'
            })
        }
    }

    /**
     * Fetches the IDs of the Steam games to post.
     */
    private async fetchGameIds(): Promise<number[]> {
        this.ensureAPI()
        const response = await this._store.get(
            'search', {
                params: {
                    sort_by: 'Released_DESC',
                    vrsupport: 402 // VR Supported
                }
            })
        let ids: number[] = []
        if (response.data) {
            const html: string = response.data
            const matches = html.matchAll(/data-ds-appid="(\d+?)"/gim)
            ids = [...matches].map(match => Number(match[1]))
        }
        console.log('Fetched', ids.length, 'game(s)')
        return ids
    }

    /**
     * Posts the games to Discord.
     * @param ids The IDs of the games to post.
     */
    private async postGames(ids: number[]) {
        const config = await Config.get()
        const metas = await this.fetchFilterAndSortGameMetas(ids)
        if (metas.length > 0) {
            for (const meta of metas) {
                await new Promise(resolve => setTimeout(resolve, 30000)) // Post with some time delay as embeds can get skipped otherwise, seemingly.

                let webhookUrl = SteamBot.isCoop(meta)
                    ? config.webhookUrlCoop
                    : SteamBot.isMulti(meta)
                        ? config.webhookUrlMulti
                        : config.webhookUrl

                const webhook = new WebhookClient({url: webhookUrl})
                const wasPosted = await this.postGame(meta, webhook)

                let date = new Date()
                date = new Date(date.getTime() + (date.getTimezoneOffset() * 60 * 1000))
                const dateStr = date.toISOString().substring(0, 10)
                if (wasPosted) await this._db.registerGameAsPosted(meta.steam_appid, dateStr)
            }
        }
    }

    /**
     * Fetches the game metas for the given IDs, filters out unreleased games and sorts them.
     * @param ids
     */
    private async fetchFilterAndSortGameMetas(ids: number[]): Promise<IGameMeta[]> {
        const metas: IGameMeta[] = []
        for (const id of ids) {
            const hasBeenPosted = await this._db.hasGameBeenPosted(id)
            if (!hasBeenPosted) {
                const meta = await this.fetchGameMeta(id)
                if (meta) {
                    metas.push(meta)
                }
            }
        }
        const filterReleased = (meta: IGameMeta) => {
            const releaseDate = new Date(meta.release_date.date)?.getTime() ?? Infinity
            const released =
                !meta.release_date.coming_soon
                && releaseDate <= Date.now()
            if (!released) console.log('Filtering out unreleased title', meta.steam_appid, meta.name, meta.release_date.date, meta.release_date.coming_soon)
            return released
        }
        const compareReleaseDatesOrNames = (a: IGameMeta, b: IGameMeta) => {
            const dateA = new Date(a.release_date.date)
            const dateB = new Date(b.release_date.date)
            const timeDiff = dateA.getTime() - dateB.getTime()
            return timeDiff !== 0 ? timeDiff : b.name.localeCompare(a.name)
        }
        return metas.filter(filterReleased).sort(compareReleaseDatesOrNames)
    }

    /**
     * Fetches the game meta for the given ID.
     */
    private async fetchGameMeta(id: number): Promise<IGameMeta | undefined> {
        this.ensureAPI()
        const response = await this._store.get(
            'api/appdetails', {
                params: {
                    appids: id
                }
            })
        if (response.data) {
            return response.data[id]?.data as IGameMeta
        }
        console.warn('Failed to get game meta for', id)
        return undefined
    }

    /**
     * Posts the game to Discord.
     */
    private async postGame(meta: IGameMeta, webhook: WebhookClient): Promise<boolean> {
        // Contents
        const contents: string[] = [
            `# [__${meta.name}__](<${SteamBot.getStoreURL(meta)}>)`,
            '**Description**',
            meta.short_description,
            '',
            '**Release Date**',
            SteamBot.getReleaseDate(meta),
            '**Price**',
            SteamBot.getPrice(meta),
            '',
            '**Genres**',
            meta.genres?.map(genre => genre.description).join(', '),
            '**Categories**',
            meta.categories?.map(category => category.description).join(', '),
            '',
            '**Developers**',
            meta.developers?.join(', '),
            '**Publishers**',
            meta.publishers?.join(', '),
            ''
        ]

        // Media
        let embedLinks = `[Banner](${meta.header_image})`

        const screenshotUrl = meta.screenshots
            ? meta.screenshots[0].path_full
            : undefined
        if (screenshotUrl) {
            embedLinks += `, [screenshot](${screenshotUrl})`
        }
        const trailerUrl = meta.movies
            ? meta.movies[0]?.mp4[480]
            : undefined
        if (trailerUrl) {
            embedLinks += `, [trailer](${trailerUrl})`
        }
        contents.push(
            '**Media**',
            embedLinks
        )

        // Send
        try {
            await webhook.send({
                content: contents.join('\n')
            })
            return true
        } catch (e) {
            console.error('Failed to send game', meta.steam_appid, meta.name, e.message)
        }
        return false
    }

    // region Static Methods
    private static getStoreURL(meta: IGameMeta): string {
        return `https://store.steampowered.com/app/${meta.steam_appid}`
    }

    private static getReleaseDate(meta: IGameMeta): string {
        const date = new Date(meta.release_date.date)
        const month = (100 + date.getMonth() + 1).toString().substring(1)
        const day = (100 + date.getDate()).toString().substring(1)
        const ymd = `${date.getFullYear()}-${month}-${day}`
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        const weekday = days[date.getDay()]
        return `${ymd} (a ${weekday})`
    }

    private static getPrice(meta: IGameMeta): string {
        const currencies: { [x: string]: string } = {
            'EUR': '€',
            'USD': '$',
            'GBP': '£',
            'KRW': '₩'
        }
        const isFree: boolean = meta.is_free
        const fullPrice: number = isFree ? 0 : meta.price_overview?.final ?? -1

        const currencyStr: string = isFree ? '' : meta.price_overview?.currency ?? ''
        const currency: string = currencies[currencyStr] ?? currencyStr

        const discount: number = isFree ? 0 : meta.price_overview?.discount_percent ?? 0
        const discountPrice = discount > 0 ? `, discounted at -${discount}% to ${currency}${(fullPrice / 100 * (1 - discount / 100)).toFixed(2)}` : ''

        return isFree
            ? 'Free'
            : fullPrice < 0
                ? 'No price'
                : `${currency}${(fullPrice / 100).toFixed(2)} ${discountPrice}`
    }

    private static isCoop(meta: IGameMeta) {
        const coopIds = [
            9, // Co-op
            38, // Online Co-op
        ]
        return meta.categories.filter(category => coopIds.includes(category.id)).length > 0
    }

    private static isMulti(meta: IGameMeta) {
        const multiIds = [
            1, // Multi-Player
            36, // Online PvP
            49, // PvP
        ]
        return meta.categories.filter(category => multiIds.includes(category.id)).length > 0
    }

    // endregion
}

// region Interfaces
interface IGameMeta {
    type: string
    name: string
    steam_appid: number
    required_age: number
    is_free: boolean
    detailed_description: string
    about_the_game: string
    short_description: string
    supported_languages: string
    header_image: string
    capsule_image: string
    capsule_imagev5: string
    website: string
    pc_requirements: IGameMetaRequirements
    mac_requirements: IGameMetaRequirements
    linux_requirements: IGameMetaRequirements
    developers: string[]
    publishers: string[]
    price_overview: IGameMetaPriceOverview
    packages: number[]
    package_groups: IGameMetaPackageGroup[]
    platforms: IGameMetaPlatforms
    categories: IGameMetaEntry[]
    genres: IGameMetaEntry[]
    screenshots: IGameMetaScreenshot[]
    movies: IGameMetaMovie[]
    achievements: IGameMetaAchievements
    release_date: IGameMetaReleaseDate
    support_info: IGameMetaSupportInfo
    background: string
    background_raw: string
    content_descriptors: IGameMetaContentDescriptors
}

interface IGameMetaRequirements {
    minimum: string
    recommended: string
}

interface IGameMetaPriceOverview {
    currency: string
    initial: number
    final: number
    discount_percent: number
    initial_formatted: string
    final_formatted: string
}

interface IGameMetaPackageGroup {
    name: string
    title: string
    description: string
    selection_text: string
    save_text: string
    display_type: number
    is_recurring_subscription: string
    subs: IGameMetaPackageGroupSub[]
}

interface IGameMetaPackageGroupSub {
    packageid: number
    percent_savings_text: string
    percent_savings: number
    option_text: string
    option_description: string
    can_get_free_license: string
    is_free_license: boolean
    price_in_cents_with_discount: number
}

interface IGameMetaPlatforms {
    windows: boolean
    mac: boolean
    linux: boolean
}

interface IGameMetaEntry {
    id: number
    description: string
}

interface IGameMetaScreenshot {
    id: number
    path_thumbnail: string
    path_full: string
}

interface IGameMetaMovie {
    id: number
    name: string
    thumbnail: string
    webm: IGameMetaMovieSource
    mp4: IGameMetaMovieSource
    highlight: boolean
}

interface IGameMetaMovieSource {
    480: string
    max: string
}

interface IGameMetaAchievements {
    total: number
    highlighted: IGameMetaAchievement[]
}

interface IGameMetaAchievement {
    name: string
    path: string
}

interface IGameMetaReleaseDate {
    coming_soon: boolean
    date: string
}

interface IGameMetaSupportInfo {
    url: string
    email: string
}

interface IGameMetaContentDescriptors {
    ids: number[]
    notes: string
}

// endregion