import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it } from "node:test";

import {
  assistant,
  pushTask,
  responds,
  task,
  taskResult,
  user,
  userCtrlC,
  TestHarness,
} from "./test-helpers/index.js";

describe("model switching on /start-task", () => {
  it("starts task without model arg (existing behavior unchanged)", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("Done.", responds("Great!"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(user("some prompt"), assistant("Done."));
      h.assertStatus("current task: AAA");
    } finally {
      h.dispose();
    }
  });

  it("uses a persisted default model for /start-task and restores it on finish", async () => {
    await withTaskSettings(
      { piSupergsd: { defaultTaskModel: "supergsd-test/other-model" } },
      async () => {
        const h = await TestHarness.create();
        registerTestModels(h, [{ id: "other-model", name: "Other Model" }]);
        h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
        h.llm.onPrompt("some prompt", responds("Done."));
        h.llm.onPrompt("Done.", responds("Great!"));

        try {
          await h.prompt("main work");
          await h.prompt("/start-task");
          h.assertModel("supergsd-test/other-model");
          h.assertSession(user("some prompt"), assistant("Done."));

          await h.prompt("/finish-task");
          h.assertModel("supergsd-test/deterministic");
          h.assertStatus();
        } finally {
          h.dispose();
        }
      },
    );
  });

  it("lets an explicit /start-task model override the persisted default", async () => {
    await withTaskSettings({ piSupergsd: { defaultTaskModel: "missing-model" } }, async () => {
      const h = await TestHarness.create();
      registerTestModels(h, [{ id: "other-model", name: "Other Model" }]);
      h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
      h.llm.onPrompt("some prompt", responds("Done."));

      try {
        await h.prompt("main work");
        await h.prompt("/start-task supergsd-test/other-model");
        h.assertModel("supergsd-test/other-model");
        h.assertSession(user("some prompt"), assistant("Done."));
      } finally {
        h.dispose();
      }
    });
  });

  it("uses the persisted default model for /auto", async () => {
    await withTaskSettings(
      { piSupergsd: { defaultTaskModel: "supergsd-test/other-model" } },
      async () => {
        const h = await TestHarness.create();
        registerTestModels(h, [{ id: "other-model", name: "Other Model" }]);
        h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
        h.llm.onPrompt("some prompt", responds("Done."));
        h.user.onAssistant("Done.", userCtrlC());

        try {
          await h.prompt("main work");
          await h.prompt("/auto");
          h.assertModel("supergsd-test/other-model");
          h.assertSession(user("some prompt"), assistant("Done."));
          h.assertStatus("current task: AAA");
        } finally {
          h.dispose();
        }
      },
    );
  });

  it("stops /auto and keeps the task pending when the default model is unavailable", async () => {
    await withTaskSettings({ piSupergsd: { defaultTaskModel: "missing-model" } }, async () => {
      const h = await TestHarness.create();
      h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));

      try {
        await h.prompt("main work");
        await h.prompt("/auto");
        h.assertModel("supergsd-test/deterministic");
        h.assertSession(
          user("main work"),
          assistant("working...", "toolUse"),
          task("AAA", "some prompt"),
        );
        h.assertStatus("pending task: AAA");
        h.assertLastNotification('No model matching "missing-model".');
      } finally {
        h.dispose();
      }
    });
  });

  it("switches model and restores on finish (substring match)", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [{ id: "other-model", name: "Other Model" }]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("Done.", responds("Great!"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task Other");
      h.assertModel("supergsd-test/other-model");
      h.assertSession(user("some prompt"), assistant("Done."));
      h.assertStatus("current task: AAA");

      await h.prompt("/finish-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Done."),
        assistant("Great!"),
      );
      h.assertStatus();
    } finally {
      h.dispose();
    }
  });

  it("switches model via provider/modelId syntax", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [{ id: "other-model", name: "Other Model" }]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("Done.", responds("Great!"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task supergsd-test/other-model");
      h.assertModel("supergsd-test/other-model");
      h.assertSession(user("some prompt"), assistant("Done."));
      h.assertStatus("current task: AAA");
    } finally {
      h.dispose();
    }
  });

  it("notifies when no model matches", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task nonexistent-model-xyz");

      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
      );
      h.assertStatus("pending task: AAA");
      h.assertLastNotification('No model matching "nonexistent-model-xyz".');
    } finally {
      h.dispose();
    }
  });

  it("notifies when multiple models match", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [
      { id: "other-model-v1", name: "Other Model V1" },
      { id: "other-model-v2", name: "Other Model V2" },
    ]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task other-model");

      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
      );
      h.assertStatus("pending task: AAA");
      h.assertLastNotification(
        "Ambiguous model: matches supergsd-test/other-model-v1, supergsd-test/other-model-v2.",
      );
    } finally {
      h.dispose();
    }
  });

  it("restores original model on nested task finish", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [{ id: "other-model", name: "Other Model" }]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("outer working..."), pushTask("BBB", "other prompt"));
    h.llm.onPrompt("other prompt", responds("inner done"));
    h.llm.onPrompt("inner done", responds("Great!"));
    h.llm.onPrompt("Great!", responds(""));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task other");
      h.assertModel("supergsd-test/other-model");
      h.assertSession(
        user("some prompt"),
        assistant("outer working...", "toolUse"),
        task("BBB", "other prompt"),
      );

      // Start nested without model switch — stays on other-model
      await h.prompt("/start-task");
      h.assertModel("supergsd-test/other-model");
      h.assertSession(user("other prompt"), assistant("inner done"));

      // Finish nested — no previousModel on its task-start, stays on other-model
      await h.prompt("/finish-task");
      h.assertModel("supergsd-test/other-model");
      h.assertSession(
        user("some prompt"),
        assistant("outer working...", "toolUse"),
        task("BBB", "other prompt"),
        taskResult("BBB", "inner done"),
        assistant("Great!"),
      );

      // Finish outer — restores to deterministic
      await h.prompt("/finish-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Great!"),
        assistant(""),
      );
      h.assertStatus();
    } finally {
      h.dispose();
    }
  });

  it("nested tasks with independent model switches", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "Model B" },
    ]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("outer working..."), pushTask("BBB", "other prompt"));
    h.llm.onPrompt("other prompt", responds("inner done"));
    h.llm.onPrompt("inner done", responds("Great!"));
    h.llm.onPrompt("Great!", responds(""));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task model-a");
      h.assertModel("supergsd-test/model-a");
      h.assertSession(
        user("some prompt"),
        assistant("outer working...", "toolUse"),
        task("BBB", "other prompt"),
      );

      await h.prompt("/start-task model-b");
      h.assertModel("supergsd-test/model-b");
      h.assertSession(user("other prompt"), assistant("inner done"));

      // Finish inner — restores to model-a
      await h.prompt("/finish-task");
      h.assertModel("supergsd-test/model-a");
      h.assertSession(
        user("some prompt"),
        assistant("outer working...", "toolUse"),
        task("BBB", "other prompt"),
        taskResult("BBB", "inner done"),
        assistant("Great!"),
      );

      // Finish outer — restores to deterministic
      await h.prompt("/finish-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Great!"),
        assistant(""),
      );
      h.assertStatus();
    } finally {
      h.dispose();
    }
  });

  it("warns when previous model unavailable on finish", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "Model B" },
    ]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("outer working..."), pushTask("BBB", "other prompt"));
    h.llm.onPrompt("other prompt", responds("inner done"));
    h.llm.onPrompt("inner done", responds("Great!"));
    h.llm.onPrompt("Great!", responds(""));

    try {
      await h.prompt("main work");
      // Switch to model-a (previousModel = deterministic)
      await h.prompt("/start-task model-a");
      h.assertModel("supergsd-test/model-a");
      h.assertSession(
        user("some prompt"),
        assistant("outer working...", "toolUse"),
        task("BBB", "other prompt"),
      );

      // Switch to model-b inside (previousModel = model-a)
      await h.prompt("/start-task model-b");
      h.assertModel("supergsd-test/model-b");
      h.assertSession(user("other prompt"), assistant("inner done"));

      // Re-register without model-a to make it unavailable
      h.modelRegistry.registerProvider("supergsd-test", {
        baseUrl: "memory://supergsd-test",
        apiKey: "test-key",
        api: "supergsd-test-api",
        models: [
          modelSpec("deterministic", "Deterministic Test Model", true),
          modelSpec("model-b", "Model B", false),
        ],
      });

      // Finish inner — tries to restore model-a, which is now unavailable
      await h.prompt("/finish-task");
      // Model stays on model-b (restore failed, active model unchanged)
      h.assertModel("supergsd-test/model-b");
      h.assertSession(
        user("some prompt"),
        assistant("outer working...", "toolUse"),
        task("BBB", "other prompt"),
        taskResult("BBB", "inner done"),
        assistant("Great!"),
      );
      h.assertLastNotification("Previous model supergsd-test/model-a no longer available.");

      // Finish outer — restores deterministic which is still available
      await h.prompt("/finish-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Great!"),
        assistant(""),
      );
      h.assertStatus();
    } finally {
      h.dispose();
    }
  });

  it("restores model on abort-task and leaves task pending", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [{ id: "other-model", name: "Other Model" }]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("Done.", responds("Great!"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task other");
      h.assertModel("supergsd-test/other-model");
      h.assertSession(user("some prompt"), assistant("Done."));
      h.assertStatus("current task: AAA");

      // Abort switches model back and leaves task pending
      await h.prompt("/abort-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
      );
      h.assertStatus("pending task: AAA");
      h.assertLastNotification("Task aborted. Branch abandoned without summary.");

      // Task can be started again (no model arg = deterministic, proving restore)
      await h.prompt("/start-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(user("some prompt"), assistant("Done."));
      h.assertStatus("current task: AAA");
    } finally {
      h.dispose();
    }
  });
});

describe("/task-model configuration", () => {
  it("selects from available Pi models and persists without switching the current model", async () => {
    await withTaskSettings(
      { theme: "default", piSupergsd: { otherSetting: true } },
      async (path) => {
        const h = await TestHarness.create();
        registerTestModels(h, [{ id: "other-model", name: "Other Model" }]);
        h.selectNext("supergsd-test/other-model");
        h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
        h.llm.onPrompt("some prompt", responds("Done."));

        try {
          await h.prompt("/task-model");
          h.assertSelectOptions(
            "Use current model (clear default)",
            ...h.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`),
          );
          assert.deepStrictEqual(JSON.parse(readFileSync(path, "utf8")), {
            theme: "default",
            piSupergsd: { otherSetting: true, defaultTaskModel: "supergsd-test/other-model" },
          });
          h.assertModel("supergsd-test/deterministic");

          await h.prompt("main work");
          await h.prompt("/start-task");
          h.assertModel("supergsd-test/other-model");
        } finally {
          h.dispose();
        }
      },
    );
  });

  it("clears the default while preserving other settings", async () => {
    await withTaskSettings(
      { theme: "default", piSupergsd: { otherSetting: true, defaultTaskModel: "other-model" } },
      async (path) => {
        const h = await TestHarness.create();
        h.selectNext("Use current model (clear default)");
        h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
        h.llm.onPrompt("some prompt", responds("Done."));

        try {
          await h.prompt("/task-model");
          assert.deepStrictEqual(JSON.parse(readFileSync(path, "utf8")), {
            theme: "default",
            piSupergsd: { otherSetting: true },
          });
          await h.prompt("main work");
          await h.prompt("/start-task");
          h.assertModel("supergsd-test/deterministic");
        } finally {
          h.dispose();
        }
      },
    );
  });

  it("creates settings.json when no Pi settings file exists", async () => {
    await withTaskSettings({}, async (path) => {
      rmSync(path);
      const h = await TestHarness.create();
      h.selectNext("supergsd-test/deterministic");
      try {
        await h.prompt("/task-model");
        assert.deepStrictEqual(JSON.parse(readFileSync(path, "utf8")), {
          piSupergsd: { defaultTaskModel: "supergsd-test/deterministic" },
        });
      } finally {
        h.dispose();
      }
    });
  });

  it("leaves settings unchanged if the picker is cancelled", async () => {
    await withTaskSettings(
      { piSupergsd: { defaultTaskModel: "supergsd-test/deterministic" } },
      async (path) => {
        const h = await TestHarness.create();
        const before = readFileSync(path, "utf8");
        try {
          await h.prompt("/task-model");
          assert.strictEqual(readFileSync(path, "utf8"), before);
        } finally {
          h.dispose();
        }
      },
    );
  });
});

async function withTaskSettings(
  settings: unknown,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-supergsd-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const path = join(agentDir, "settings.json");
    writeFileSync(path, JSON.stringify(settings));
    await run(path);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

/** Register extra test models under the supergsd-test provider. */
function registerTestModels(h: TestHarness, models: Array<{ id: string; name: string }>) {
  h.modelRegistry.registerProvider("supergsd-test", {
    baseUrl: "memory://supergsd-test",
    apiKey: "test-key",
    api: "supergsd-test-api",
    models: [
      modelSpec("deterministic", "Deterministic Test Model", true),
      ...models.map((m) => modelSpec(m.id, m.name, false)),
    ],
  });
}

function modelSpec(id: string, name: string, reasoning: boolean) {
  return {
    id,
    name,
    reasoning,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  };
}
