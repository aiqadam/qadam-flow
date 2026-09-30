import { ErrorCode, QadamFlowError, tryCatchSync } from '@aiqadam/shared'
import { FlowRunEntity } from '../../../../src/app/flows/flow-run/flow-run-entity'
import { buildPaginator, MAX_PAGE_SIZE } from '../../../../src/app/helper/pagination/build-paginator'
import Paginator from '../../../../src/app/helper/pagination/paginator'

describe('buildPaginator limit guard (#561)', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it.each([-1, 1.5, Number.NaN])('rejects limit=%s with a VALIDATION error', (limit) => {
        const { error } = tryCatchSync(() => buildPaginator({ entity: FlowRunEntity, query: { limit } }))

        expect(error).toBeInstanceOf(QadamFlowError)
        expect(error instanceof QadamFlowError && error.error.code).toBe(ErrorCode.VALIDATION)
    })

    it('treats limit=0 as not set, as it did before #561', () => {
        const setLimit = vi.spyOn(Paginator.prototype, 'setLimit')

        const { error } = tryCatchSync(() => buildPaginator({ entity: FlowRunEntity, query: { limit: 0 } }))

        expect(error).toBeNull()
        expect(setLimit).not.toHaveBeenCalled()
    })

    it('clamps a limit above MAX_PAGE_SIZE', () => {
        const setLimit = vi.spyOn(Paginator.prototype, 'setLimit')

        buildPaginator({ entity: FlowRunEntity, query: { limit: 1_000_000_000 } })

        expect(setLimit).toHaveBeenCalledWith(MAX_PAGE_SIZE)
    })

    it('passes a limit within bounds through unchanged', () => {
        const setLimit = vi.spyOn(Paginator.prototype, 'setLimit')

        buildPaginator({ entity: FlowRunEntity, query: { limit: MAX_PAGE_SIZE } })
        buildPaginator({ entity: FlowRunEntity, query: { limit: 1 } })

        expect(setLimit.mock.calls).toEqual([[MAX_PAGE_SIZE], [1]])
    })

    it('reaches an unlimited read only through the explicit server-side option', () => {
        const setLimit = vi.spyOn(Paginator.prototype, 'setLimit')
        const setUnlimited = vi.spyOn(Paginator.prototype, 'setUnlimited')

        buildPaginator({ entity: FlowRunEntity, query: { limit: 5 }, unlimited: true })

        expect(setUnlimited).toHaveBeenCalledTimes(1)
        expect(setLimit).not.toHaveBeenCalled()
    })
})
