import { z } from 'zod';
import { ActionContext } from '../context';
import type { OutputSchema } from '../output-schema';
import { ActionBase, Audience, AiMetadata } from '../qadam-metadata';
import { InputPropertyMap } from '../property';
import { ExtractQadamAuthPropertyTypeForMethods, QadamAuthProperty } from '../property/authentication';

export type ActionRunner<QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined = QadamAuthProperty, ActionProps extends InputPropertyMap = InputPropertyMap> =
  (ctx: ActionContext<QadamAuth, ActionProps>) => Promise<unknown | void>

export const ErrorHandlingOptionsParam = z.object({
  retryOnFailure: z.object({
    defaultValue: z.boolean().optional(),
    hide: z.boolean().optional(),
  }),
  continueOnFailure: z.object({
    defaultValue: z.boolean().optional(),
    hide: z.boolean().optional(),
  }),
})
export type ErrorHandlingOptionsParam = z.infer<typeof ErrorHandlingOptionsParam>

type CreateActionParams<QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined, ActionProps extends InputPropertyMap> = {
  /**
   * A dummy parameter used to infer {@code QadamAuth} type
   */
  name: string
  /**
   * this parameter is used to infer the type of the piece auth value in run and test methods
   */
  auth?: QadamAuth
  displayName: string
  description: string
  props: ActionProps
  run: ActionRunner<ExtractQadamAuthPropertyTypeForMethods<QadamAuth>, ActionProps>
  test?: ActionRunner<ExtractQadamAuthPropertyTypeForMethods<QadamAuth>, ActionProps>
  requireAuth?: boolean
  errorHandlingOptions?: ErrorHandlingOptionsParam
  outputSchema?: OutputSchema
  audience?: Audience
  aiMetadata?: AiMetadata
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class IAction<QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined = any, ActionProps extends InputPropertyMap = InputPropertyMap> implements ActionBase {
  constructor(
    public readonly name: string,
    public readonly displayName: string,
    public readonly description: string,
    public readonly props: ActionProps,
    public readonly run: ActionRunner<ExtractQadamAuthPropertyTypeForMethods<QadamAuth>, ActionProps>,
    public readonly test: ActionRunner<ExtractQadamAuthPropertyTypeForMethods<QadamAuth>, ActionProps>,
    public readonly requireAuth: boolean,
    public readonly errorHandlingOptions: ErrorHandlingOptionsParam,
    public readonly outputSchema?: OutputSchema,
    public readonly audience?: Audience,
    public readonly aiMetadata?: AiMetadata,
  ) { }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Action<
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined = any,
  ActionProps extends InputPropertyMap = any,
> = IAction<QadamAuth, ActionProps>

export const createAction = <
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined = QadamAuthProperty,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ActionProps extends InputPropertyMap = any
>(
  params: CreateActionParams<QadamAuth, ActionProps>,
) => {
  return new IAction(
    params.name,
    params.displayName,
    params.description,
    params.props,
    params.run,
    params.test ?? params.run,
    params.requireAuth ?? true,
    params.errorHandlingOptions ?? {
      continueOnFailure: {
        defaultValue: false,
      },
      retryOnFailure: {
        defaultValue: false,
      }
    },
    params.outputSchema,
    params.audience,
    params.aiMetadata,
  )
}
