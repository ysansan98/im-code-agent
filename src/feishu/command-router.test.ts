import { describe, expect, test } from "vite-plus/test";

import {
  extractPromptFromMessage,
  parseCardActionValue,
  parseUserCommand,
} from "./command-router.ts";

describe("parseUserCommand", () => {
  test("parses help/status/stop/model commands", async () => {
    await expect(parseUserCommand("/help", "/repo")).resolves.toEqual({ type: "help" });
    await expect(parseUserCommand("/status", "/repo")).resolves.toEqual({ type: "status" });
    await expect(parseUserCommand("/stop", "/repo")).resolves.toEqual({ type: "stop" });
    await expect(parseUserCommand("/model", "/repo")).resolves.toEqual({ type: "model" });
    await expect(parseUserCommand("/model gpt-5", "/repo")).resolves.toEqual({
      type: "model",
      model: "gpt-5",
    });
  });

  test("parses new command with path", async () => {
    await expect(parseUserCommand("/new .", "/tmp")).resolves.toEqual({
      type: "new",
      cwd: "/tmp",
    });
  });
});

describe("parseCardActionValue", () => {
  test("parses model card callback payload", () => {
    expect(
      parseCardActionValue({
        action: {
          value: JSON.stringify({
            type: "model",
            cardId: "card-1",
            chatId: "chat-1",
            model: "gpt-5",
          }),
        },
      }),
    ).toEqual({
      type: "model",
      cardId: "card-1",
      chatId: "chat-1",
      model: "gpt-5",
    });
  });
});

describe("extractPromptFromMessage", () => {
  test("supports text message", () => {
    expect(extractPromptFromMessage("text", JSON.stringify({ text: "  hello  " }))).toBe("hello");
  });

  test("supports image message", () => {
    expect(extractPromptFromMessage("image", JSON.stringify({ image_key: "img_xxx" }))).toContain(
      "image_key=img_xxx",
    );
  });

  test("supports post message", () => {
    expect(
      extractPromptFromMessage(
        "post",
        JSON.stringify({
          zh_cn: {
            title: "标题",
            content: [
              [
                { tag: "text", text: "第一行 " },
                { tag: "a", text: "链接" },
                { tag: "at", user_name: "张三" },
              ],
              [{ tag: "text", text: "第二行" }],
            ],
          },
        }),
      ),
    ).toBe("标题\n第一行 链接@张三\n第二行");
  });

  test("falls back to raw post content when payload shape is unknown", () => {
    const raw = JSON.stringify({ unknown: { foo: "bar" } });
    expect(extractPromptFromMessage("post", raw)).toBe(raw);
  });

  test("falls back to raw image content when image_key is missing", () => {
    const raw = JSON.stringify({ foo: "bar" });
    expect(extractPromptFromMessage("image", raw)).toBe(raw);
  });

  test("returns empty for unsupported type", () => {
    expect(extractPromptFromMessage("audio", JSON.stringify({}))).toBe("");
  });
});
