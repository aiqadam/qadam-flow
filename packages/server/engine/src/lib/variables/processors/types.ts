
/* eslint-disable @typescript-eslint/no-explicit-any */
import { QadamProperty } from '@aiqadam/qadams-framework'

export type ProcessorFn<INPUT = any, OUTPUT = any> = (
    property: QadamProperty,
    value: INPUT,
) => OUTPUT
