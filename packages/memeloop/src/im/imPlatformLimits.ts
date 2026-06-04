/** Plan §20.6.1 — chunk assistant text before sending to IM APIs. */
export function imPlatformMaxMessageChars(platform: string): number {
  switch (platform) {
    case 'telegram':
      return 4096;
    case 'discord':
      return 2000;
    case 'lark':
      return 4096;
    case 'wecom':
      return 2048;
    case 'slack':
      return 4000;
    case 'qq':
      return 4500;
    default:
      return 3500;
  }
}
