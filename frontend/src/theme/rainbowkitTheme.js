import { darkTheme } from '@rainbow-me/rainbowkit';

/**
 * DESIGN.md token values, inlined because this module feeds a JS theme object
 * rather than CSS. Keep in step with the custom properties in src/index.css.
 */
const token = {
  voidBlack: '#0b0e12',
  carbon: '#181a1d',
  graphite: '#1f2124',
  slate: '#303235',
  fog: '#5d5e61',
  steel: '#818284',
  ash: '#a3a4a5',
  silver: '#bababb',
  bone: '#dedede',
  phosphorGreen: '#00d892',
  deepTeal: '#002923',
  emeraldDepth: '#005441',
  syntaxCoral: '#ff6285',
};

const fontStack =
  "'SuisseIntl', Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/**
 * RainbowKit theme built from DESIGN.md.
 *
 * Two rules drive the mapping:
 *  - Phosphor Green is never a fill. RainbowKit's `accentColor` is a *button
 *    background*, so it takes Deep Teal while `accentColorForeground` takes
 *    Phosphor Green — exactly the Filled Primary Button spec.
 *  - Elevation comes from 1px hairlines and surface stepping, never shadows.
 *    1px radius everywhere; no blur on overlays beyond a light scrim.
 */
export const x402RainbowKitTheme = {
  ...darkTheme({
    accentColor: token.deepTeal,
    accentColorForeground: token.phosphorGreen,
    borderRadius: 'small',
    fontStack,
    overlayBlur: 'small',
  }),
  colors: {
    ...darkTheme().colors,

    accentColor: token.deepTeal,
    accentColorForeground: token.phosphorGreen,

    actionButtonBorder: token.slate,
    actionButtonBorderMobile: token.slate,
    actionButtonSecondaryBackground: token.graphite,

    closeButton: token.ash,
    closeButtonBackground: token.carbon,

    connectButtonBackground: token.carbon,
    connectButtonBackgroundError: token.carbon,
    connectButtonInnerBackground: token.graphite,
    connectButtonText: token.silver,
    connectButtonTextError: token.syntaxCoral,

    connectionIndicator: token.phosphorGreen,

    downloadBottomCardBackground: token.carbon,
    downloadTopCardBackground: token.graphite,

    error: token.syntaxCoral,

    generalBorder: token.slate,
    generalBorderDim: token.graphite,

    menuItemBackground: token.graphite,

    modalBackdrop: 'rgba(11, 14, 18, 0.8)',
    modalBackground: token.carbon,
    modalBorder: token.slate,
    modalText: token.bone,
    modalTextDim: token.steel,
    modalTextSecondary: token.silver,

    profileAction: token.graphite,
    profileActionHover: token.slate,
    profileForeground: token.carbon,

    selectedOptionBorder: token.phosphorGreen,
    standby: token.steel,
  },
  fonts: {
    ...darkTheme().fonts,
    body: fontStack,
  },
  radii: {
    actionButton: '1px',
    connectButton: '1px',
    menuButton: '1px',
    modal: '1px',
    modalMobile: '1px',
  },
  // DESIGN.md forbids drop shadows for elevation. These keys are the complete
  // `shadows` contract in RainbowKit's ThemeVars — adding or omitting one throws
  // "Path shadows -> … does not exist in object".
  shadows: {
    connectButton: 'none',
    dialog: 'none',
    profileDetailsAction: 'none',
    selectedOption: 'none',
    selectedWallet: 'none',
    walletLogo: 'none',
  },
};
