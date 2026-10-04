import type * as vscode from 'vscode';

const WEBVIEW_ASSET_ROOT = ['dist', 'webview'] as const;

export function webviewPanelOptions(
  api: typeof vscode,
  extensionUri: vscode.Uri,
): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: false,
    localResourceRoots: [api.Uri.joinPath(extensionUri, ...WEBVIEW_ASSET_ROOT)],
  };
}

export function webviewAssetUri(
  webview: vscode.Webview,
  api: typeof vscode,
  extensionUri: vscode.Uri,
  filename: string,
): vscode.Uri {
  return webview.asWebviewUri(api.Uri.joinPath(extensionUri, ...WEBVIEW_ASSET_ROOT, filename));
}

export function webviewStylesheets(
  webview: vscode.Webview,
  api: typeof vscode,
  extensionUri: vscode.Uri,
  surfaceStylesheet: string,
): string {
  const shared = webviewAssetUri(webview, api, extensionUri, 'webview-theme.css');
  const surface = webviewAssetUri(webview, api, extensionUri, surfaceStylesheet);
  return `<link rel="stylesheet" href="${shared}"><link rel="stylesheet" href="${surface}">`;
}
