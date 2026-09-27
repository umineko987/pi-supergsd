import { stripVTControlCharacters } from "node:util";

import { Theme } from "@earendil-works/pi-coding-agent";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
export class TestUi {
  #lastNotification: string | undefined;
  #lastStatus: string | undefined;
  #selections: string[] = [];
  #lastSelectOptions: string[] | undefined;
  #firstCustomView: string[] | undefined;
  #lastCustomView: string[] | undefined;

  readonly context: ExtensionUIContext = {
    ...noOpContext,
    select: async (_title, options) => {
      this.#lastSelectOptions = options;
      const selected = this.#selections.shift();
      if (selected && !options.includes(selected)) {
        throw new Error(`Unexpected selection: ${selected}`);
      }
      return selected;
    },
    custom: async (factory) =>
      new Promise((done, reject) => {
        void Promise.resolve(
          factory(
            { requestRender() {} } as TUI,
            this.context.theme,
            {
              matches(data: string, binding: string) {
                return (
                  (
                    {
                      "tui.select.up": "\x1b[A",
                      "tui.select.down": "\x1b[B",
                      "tui.select.confirm": "\r",
                      "tui.select.cancel": "\x1b",
                    } as Record<string, string>
                  )[binding] === data
                );
              },
            } as Parameters<typeof factory>[2],
            done,
          ),
        ).then((component) => {
          try {
            const choice = this.#selections.shift();
            this.#firstCustomView = undefined;
            for (let i = 0; i < 512; i++) {
              const view = component.render(96).map((line) => normalizeText(line) ?? "");
              this.#firstCustomView ??= view;
              this.#lastCustomView = view;
              if (choice === undefined) {
                component.handleInput?.("\x1b");
                return;
              }
              if (view.some((line) => line.startsWith(`→ ${choice}`))) {
                component.handleInput?.("\r");
                return;
              }
              component.handleInput?.("\x1b[B");
            }
            throw new Error(`Unable to select ${choice} in custom UI`);
          } catch (error) {
            reject(error);
          }
        }, reject);
      }),
    notify: (message: string) => {
      this.#lastNotification = normalizeText(message);
    },
    setStatus: (key: string, value: string | undefined) => {
      if (key !== "task") return;
      this.#lastStatus = normalizeText(value);
    },
  };

  get lastStatus(): string | undefined {
    return this.#lastStatus;
  }

  get lastNotification(): string | undefined {
    return this.#lastNotification;
  }

  selectNext(option: string): void {
    this.#selections.push(option);
  }

  get lastSelectOptions(): string[] | undefined {
    return this.#lastSelectOptions;
  }
  get firstCustomView(): string[] | undefined {
    return this.#firstCustomView;
  }

  get lastCustomView(): string[] | undefined {
    return this.#lastCustomView;
  }
}

function normalizeText(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const result = stripVTControlCharacters(value).trim();
  return result === "" ? undefined : result;
}

const noOpContext: ExtensionUIContext = {
  async select() {
    return undefined;
  },
  async confirm() {
    return false;
  },
  async input() {
    return undefined;
  },
  notify() {},
  onTerminalInput() {
    return () => {};
  },
  setStatus() {},
  setWorkingMessage() {},
  setWorkingVisible() {},
  setWorkingIndicator() {},
  setHiddenThinkingLabel() {},
  setWidget() {},
  setFooter() {},
  setHeader() {},
  setTitle() {},
  async custom() {
    return undefined as never;
  },
  pasteToEditor() {},
  setEditorText() {},
  getEditorText() {
    return "";
  },
  async editor() {
    return undefined;
  },
  addAutocompleteProvider() {},
  setEditorComponent() {},
  getEditorComponent() {
    return undefined;
  },
  theme: new Theme(
    {
      accent: 0,
      border: 0,
      borderAccent: 0,
      borderMuted: 0,
      success: 0,
      error: 0,
      warning: 0,
      muted: 0,
      dim: 0,
      text: 0,
      thinkingText: 0,
      userMessageText: 0,
      customMessageText: 0,
      customMessageLabel: 0,
      toolTitle: 0,
      toolOutput: 0,
      mdHeading: 0,
      mdLink: 0,
      mdLinkUrl: 0,
      mdCode: 0,
      mdCodeBlock: 0,
      mdCodeBlockBorder: 0,
      mdQuote: 0,
      mdQuoteBorder: 0,
      mdHr: 0,
      mdListBullet: 0,
      toolDiffAdded: 0,
      toolDiffRemoved: 0,
      toolDiffContext: 0,
      syntaxComment: 0,
      syntaxKeyword: 0,
      syntaxFunction: 0,
      syntaxVariable: 0,
      syntaxString: 0,
      syntaxNumber: 0,
      syntaxType: 0,
      syntaxOperator: 0,
      syntaxPunctuation: 0,
      thinkingOff: 0,
      thinkingMinimal: 0,
      thinkingLow: 0,
      thinkingMedium: 0,
      thinkingHigh: 0,
      thinkingXhigh: 0,
      bashMode: 0,
    },
    {
      selectedBg: 0,
      userMessageBg: 0,
      customMessageBg: 0,
      toolPendingBg: 0,
      toolSuccessBg: 0,
      toolErrorBg: 0,
    },
    "truecolor",
  ),
  getAllThemes() {
    return [];
  },
  getTheme() {
    return undefined;
  },
  setTheme() {
    return { success: false, error: "Theme switching not supported in tests." };
  },
  getToolsExpanded() {
    return false;
  },
  setToolsExpanded() {},
};
