import tinycolor from 'tinycolor2'

function generateColorVariations(defaultColor: string) {
    const defaultColorObj = tinycolor(defaultColor)

    const darkColor = defaultColorObj.clone().darken(2)
    const baseLight = tinycolor('#ffffff')
    const lightColor = tinycolor
        .mix(baseLight, defaultColorObj.toHex(), 12)
        .toHexString()
    const mediumColor = defaultColorObj.clone().lighten(26)

    return {
        default: defaultColorObj.toHexString(),
        dark: darkColor.toHexString(),
        light: lightColor,
        medium: mediumColor.toHexString(),
    }
}

function generateSelectionColor(defaultColor: string) {
    const defaultColorObj = tinycolor(defaultColor)
    const lightColor = defaultColorObj.lighten(8)
    return lightColor.toHexString()
}

export function generateTheme({
    primaryColor,
    fullLogoUrl,
    favIconUrl,
    logoIconUrl,
    websiteName,
}: {
    primaryColor: string
    fullLogoUrl: string
    favIconUrl: string
    logoIconUrl: string
    websiteName: string
}) {
    return {
        websiteName,
        colors: {
            avatar: '#515151',
            'blue-link': '#1890ff',
            danger: '#f94949',
            primary: generateColorVariations(primaryColor),
            warn: {
                default: '#f78a3b',
                light: '#fff6e4',
                dark: '#cc8805',
            },
            success: {
                default: '#14ae5c',
                light: '#3cad71',
            },
            selection: generateSelectionColor(primaryColor),
        },
        logos: {
            fullLogoUrl,
            favIconUrl,
            logoIconUrl,
        },
    }
}

export const defaultTheme = generateTheme({
    primaryColor: '#3CA29E',
    websiteName: 'Qadam Flow',
    // The Qadam Flow lockup — mark, "AN AI QADAM BUILD PROJECT" and the product name — not the
    // bare footprint. `/logo.svg` is square, so every consumer that sizes by width rendered it as
    // a 210px-tall foot with nothing identifying the product; the email header was the worst case.
    //
    // PNG rather than SVG on purpose: this value is embedded in email, and Gmail strips SVG
    // outright while Outlook's Word engine cannot render it. It is the same reason og:image points
    // at a PNG (see the note in packages/web/public/og-image.svg). Regenerate it from
    // logo-flow.svg if the artwork changes.
    fullLogoUrl: '/logo-flow.png',
    // Matches the AP_FAVICON shipped by packages/web/vite.config.mts so a
    // fresh, unbranded install still renders an icon instead of an empty href.
    favIconUrl: '/logo-192.png',
    logoIconUrl: '/logo.svg',
})
