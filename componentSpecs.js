export const TYPOGRAPHY_SPECS = [
  { name: "Type/Heading", token: "semantic.type.heading", fontSize: 40, lineHeight: 48, fontWeight: 700 },
  { name: "Type/Subheading", token: "semantic.type.subheading", fontSize: 28, lineHeight: 36, fontWeight: 600 },
  { name: "Type/Body", token: "semantic.type.body", fontSize: 16, lineHeight: 24, fontWeight: 400 },
  { name: "Type/Body Small", token: "semantic.type.body-small", fontSize: 14, lineHeight: 20, fontWeight: 400 },
  { name: "Type/Caption", token: "semantic.type.caption", fontSize: 12, lineHeight: 16, fontWeight: 400 },
  { name: "Type/Label", token: "semantic.type.label", fontSize: 14, lineHeight: 20, fontWeight: 500 },
  { name: "Type/Button", token: "semantic.type.button", fontSize: 14, lineHeight: 20, fontWeight: 600 },
];

export const COMPONENT_SPECS = [
  {
    name: "Button",
    layout: "horizontal",
    variants: ["primary", "secondary", "ghost", "destructive"],
    sizes: ["sm", "md", "lg"],
    states: ["default", "hover", "disabled", "loading"],
    slots: ["icon-left", "label", "icon-right"],
    tokenBindings: {
      bg: {
        primary: "semantic.component.button.primary.bg",
        secondary: "semantic.component.button.secondary.bg",
        ghost: "semantic.bg.default",
        destructive: "semantic.bg.danger"
      },
      text: {
        primary: "semantic.component.button.primary.text",
        secondary: "semantic.component.button.secondary.text",
        ghost: "semantic.text.primary",
        destructive: "semantic.text.inverted"
      },
      border: {
        primary: "semantic.component.button.primary.border",
        secondary: "semantic.component.button.secondary.border",
        ghost: "semantic.border.subtle",
        destructive: "semantic.border.danger"
      },
      typography: "Type/Button"
    }
  },
  {
    name: "Input",
    layout: "vertical",
    variants: ["default", "error", "success"],
    sizes: ["sm", "md", "lg"],
    states: ["default", "focus", "disabled"],
    slots: ["label", "input", "helper-text", "icon"],
    tokenBindings: {
      bg: "semantic.component.input.bg",
      text: "semantic.component.input.text",
      border: "semantic.component.input.border",
      placeholder: "semantic.component.input.placeholder",
      focusBorder: "semantic.border.focus",
      errorBorder: "semantic.border.danger",
      successBorder: "semantic.border.success",
      labelTypography: "Type/Label",
      fieldTypography: "Type/Body",
      helperTypography: "Type/Caption"
    }
  },
  {
    name: "Card",
    layout: "vertical",
    variants: ["default", "outline", "elevated"],
    sizes: ["md"],
    states: ["default"],
    slots: ["header", "title", "content", "footer"],
    tokenBindings: {
      bg: "semantic.component.card.bg",
      border: "semantic.component.card.border",
      titleTypography: "Type/Subheading",
      bodyTypography: "Type/Body"
    }
  },
  {
    name: "Badge",
    layout: "horizontal",
    variants: ["default", "success", "warning", "danger", "brand"],
    sizes: ["sm", "md"],
    states: ["default"],
    slots: ["label"],
    tokenBindings: {
      bg: "semantic.component.badge.bg",
      text: "semantic.component.badge.text",
      typography: "Type/Label"
    }
  }
];

export const FOUNDATION_PAGES = [
  "00 Cover",
  "01 Tokens",
  "02 Components",
  "03 Patterns",
  "10 Screens - Project",
  "90 Sandbox"
];
