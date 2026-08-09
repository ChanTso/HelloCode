export function stripTerminalControls(text: string): string {
  return (
    text
      .replace(/\r\n?/gu, "\n")
      // eslint-disable-next-line no-control-regex -- terminal escape sequences are the subject of this sanitizer.
      .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
      // eslint-disable-next-line no-control-regex -- terminal escape sequences are the subject of this sanitizer.
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
      // eslint-disable-next-line no-control-regex -- terminal control characters are the subject of this sanitizer.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
      .replace(
        /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu,
        "",
      )
  );
}

export function quoteTerminalText(text: string): string {
  return JSON.stringify(stripTerminalControls(text));
}
