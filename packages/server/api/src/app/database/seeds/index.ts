import { devDataSeed } from './dev-seeds'

export const databaseSeeds = {
    async run() {
        const seeds = [
            devDataSeed,
        ]
        for (const seed of seeds) {
            await seed.run()
        }
    },
}
