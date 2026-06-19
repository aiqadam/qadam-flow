import { z } from "zod";
import { BaseQadamAuthSchema } from "./common";
import { TPropertyValue } from "../input/common";
import { PropertyType } from "../input/property-type";

export const SecretTextProperty = z.object({
    ...BaseQadamAuthSchema.shape,
    ...TPropertyValue(z.object({
        auth: z.string()
    }), PropertyType.SECRET_TEXT).shape,
})


export type SecretTextProperty<R extends boolean> =
    BaseQadamAuthSchema<string> &
    TPropertyValue<
        string,
        PropertyType.SECRET_TEXT,
        R
    >;
