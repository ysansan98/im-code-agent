import lark from "@larksuiteoapi/node-sdk";

type RegisterPayload = Record<string, (data: unknown) => Promise<unknown>>;

type EventDispatcherWithLooseRegister = {
  register: (handles: RegisterPayload) => void;
};

type BuildEventDispatcherDeps = {
  onMessageReceived: (data: unknown) => Promise<void>;
  onCardAction: (data: unknown) => Promise<Record<string, unknown> | undefined>;
};

export function buildFeishuEventDispatcher(deps: BuildEventDispatcherDeps): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: unknown) => {
      await deps.onMessageReceived(data);
    },
  });

  registerLoosely(dispatcher, {
    "card.action.trigger": async (data: unknown) => {
      const response = await deps.onCardAction(data);
      return response ?? {};
    },
  });

  return dispatcher;
}

function registerLoosely(dispatcher: lark.EventDispatcher, handles: RegisterPayload): void {
  (dispatcher as unknown as EventDispatcherWithLooseRegister).register(handles);
}
