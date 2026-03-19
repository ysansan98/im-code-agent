import { describe, expect, test } from "vite-plus/test";

import { parseCardActionValue, parseUserCommand } from "./command-router.ts";

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
