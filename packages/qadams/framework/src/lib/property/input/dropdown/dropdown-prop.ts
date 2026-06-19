import { BasePropertySchema, TPropertyValue } from "../common";
import { DropdownState } from "./common";
import { AppConnectionValueForAuthProperty, PropertyContext } from "../../../context";
import { z } from "zod";
import { PropertyType } from "../property-type";
import { QadamAuthProperty } from "../../authentication";

type DynamicDropdownOptions<T, QadamAuth extends QadamAuthProperty | QadamAuthProperty[] |  undefined = undefined> = (
  propsValue: Record<string, unknown> & {
    auth?: QadamAuth extends undefined ? undefined : AppConnectionValueForAuthProperty<Exclude<QadamAuth, undefined>>;
  },
  ctx: PropertyContext,
) => Promise<DropdownState<T>>;

export const DropdownProperty = z.object({
  ...BasePropertySchema.shape,
  ...TPropertyValue(z.unknown(), PropertyType.DROPDOWN).shape,
  refreshers: z.array(z.string()),
});

export type DropdownProperty<T, R extends boolean, QadamAuth extends QadamAuthProperty | QadamAuthProperty[] |  undefined = undefined> = BasePropertySchema & {
  /**
   * A dummy property used to infer {@code QadamAuth} type
   */
  auth: QadamAuth;
  refreshers: string[];
  refreshOnSearch?: boolean;
  options: DynamicDropdownOptions<T, QadamAuth>;
} & TPropertyValue<T, PropertyType.DROPDOWN, R>;


export const MultiSelectDropdownProperty = z.object({
  ...BasePropertySchema.shape,
  ...TPropertyValue(z.array(z.unknown()), PropertyType.MULTI_SELECT_DROPDOWN).shape,
  refreshers: z.array(z.string()),
});

export type MultiSelectDropdownProperty<
  T,
  R extends boolean,
  QadamAuth extends QadamAuthProperty | QadamAuthProperty[] | undefined = undefined
> = BasePropertySchema & {
  /**
   * A dummy property used to infer {@code QadamAuth} type
   */
  auth: QadamAuth;
  refreshers: string[];
  refreshOnSearch?: boolean;
  options: DynamicDropdownOptions<T, QadamAuth>;
} & TPropertyValue<
  T[],
  PropertyType.MULTI_SELECT_DROPDOWN,
  R
>;
