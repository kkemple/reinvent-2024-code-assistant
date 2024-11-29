require("isomorphic-fetch");
const { App, LogLevel, Assistant } = require("@slack/bolt");
const { config } = require("dotenv");
const { HfInference } = require("@huggingface/inference");

config();

/** Initialization */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
});

// HuggingFace configuration
const hfClient = new HfInference(process.env.HUGGINGFACE_API_KEY);

// Model instructions
const DEFAULT_SYSTEM_CONTENT = `You're an AI assistant specialized in answering questions about code.
You'll analyze code-related questions and provide clear, accurate responses.
When you include markdown text, convert them to Slack compatible ones.
When you include code examles, convert them to Slack compatible ones.
When a prompt has Slack's special syntax like <@USER_ID> or <#CHANNEL_ID>, you must keep them as-is in your response.`;

// Create the assistant
const assistant = new Assistant({
  threadStarted: async ({ say, setSuggestedPrompts }) => {
    try {
      await say(
        "Hi! I'm your coding assistant. Ask me any questions about code!",
      );

      await saveThreadContext();

      const prompts = [
        {
          title: "Code Example",
          message:
            "Show me an example of implementing a binary search tree in JavaScript.",
        },
        {
          title: "Code Review",
          message:
            "What are best practices for writing clean, maintainable code?",
        },
        {
          title: "Debug Help",
          message: "How do I debug memory leaks in Node.js applications?",
        },
      ];

      await setSuggestedPrompts({
        prompts,
        title: "Here are some questions you can ask:",
      });
    } catch (error) {
      console.error("Error in threadStarted:", error);
    }
  },

  userMessage: async ({ message, client, say, setTitle, setStatus }) => {
    const { channel, thread_ts } = message;

    try {
      await setTitle(message.text);
      await setStatus("is thinking...");

      // Retrieve the Assistant thread history for context of question being asked
      const thread = await client.conversations.replies({
        channel,
        ts: thread_ts,
        oldest: thread_ts,
      });

      // Prepare and tag each message for LLM processing
      const userMessage = { role: "user", content: message.text };
      const threadHistory = thread.messages.map((m) => {
        const role = m.bot_id ? "assistant" : "user";
        return { role, content: m.text };
      });

      const messages = [
        { role: "system", content: DEFAULT_SYSTEM_CONTENT },
        ...threadHistory,
        userMessage,
      ];

      const chatCompletion = await hfClient.chatCompletion({
        model: "Qwen/Qwen2.5-Coder-32B-Instruct",
        messages,
        max_tokens: 2000,
      });

      await setStatus("is typing...");
      await say(chatCompletion.choices[0].message.content);
    } catch (error) {
      console.error("Error in userMessage:", error);
      await say(
        "I'm sorry, I ran into an error processing your request. Please try again.",
      );
    }
  },
});

// Register the assistant with the app
app.assistant(assistant);

// Set up custom function for assistant
app.function("code_assist", async ({ inputs, complete, fail }) => {
  try {
    const { question } = inputs;

    const messages = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      { role: "user", content: question },
    ];

    const chatCompletion = await hfClient.chatCompletion({
      model: "Qwen/Qwen2.5-Coder-32B-Instruct",
      messages,
      max_tokens: 2000,
    });

    await complete({
      outputs: { response: chatCompletion.choices[0].message.content },
    });
  } catch (error) {
    console.error(error);
    fail({ error: `Failed to complete the step: ${error}` });
  }
});

// Start the app
(async () => {
  try {
    await app.start();
    console.log("⚡️ Code Assistant app is running!");
  } catch (error) {
    console.error("Failed to start app:", error);
  }
})();
