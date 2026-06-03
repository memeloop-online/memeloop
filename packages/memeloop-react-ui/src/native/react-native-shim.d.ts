/** 可选 peer：仅在 React Native 宿主解析；构建期占位避免 tsc 报错。 */
declare module "react-native" {
  import type { ComponentType, ReactNode } from "react";
  export const View: ComponentType<{ style?: unknown; children?: ReactNode }>;
  export const Text: ComponentType<{ style?: unknown; children?: ReactNode }>;
}
