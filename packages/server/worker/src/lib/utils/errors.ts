export const errorUtils = {
    messageOf(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    },
}
