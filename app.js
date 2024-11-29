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
When you include code examles, convert them to Slack compatible ones. (There must be an empty line before a code block.)
When a prompt has Slack's special syntax like <@USER_ID> or <#CHANNEL_ID>, you must keep them as-is in your response.`;

function convertMarkdownToSlack(markdown) {
  let text = markdown;

  // Handle code blocks - must add newline before, and ensure backticks are on own lines
  text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    // Ensure code doesn't start or end with newline
    code = code.trim();
    // Return formatted block with newlines
    return "\n\n```\n" + code + "\n```";
  });

  // Convert inline code
  text = text.replace(/`([^`]+)`/g, "`$1`");

  // Convert bold
  text = text.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  text = text.replace(/__([^_]+)__/g, "*$1*");

  // Convert italic
  text = text.replace(/\*([^*]+)\*/g, "_$1_");
  text = text.replace(/_([^_]+)_/g, "_$1_");

  // Convert strikethrough
  text = text.replace(/~~([^~]+)~~/, "~$1~");

  // Convert blockquotes
  text = text.replace(/^>\s(.+)/gm, ">>>\n$1");

  // Convert headers to bold
  text = text.replace(/^#{1,6}\s(.+)$/gm, "*$1*");

  // Convert unordered lists
  text = text.replace(/^[\*\-\+]\s(.+)/gm, "• $1");

  // Convert ordered lists
  text = text.replace(/^\d+\.\s(.+)/gm, "$1");

  // Convert links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  return text;
}

// Create the assistant
const assistant = new Assistant({
  threadStarted: async ({ say, setSuggestedPrompts }) => {
    try {
      await say(
        "Hi! I'm your coding assistant. Ask me any questions about code!",
      );

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
      await say(
        convertMarkdownToSlack(chatCompletion.choices[0].message.content),
      );
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
app.function("code_assist", async ({ client, inputs, complete, fail }) => {
  try {
    const { channel_id, message_id } = inputs;
    let messages;

    try {
      const result = await client.conversations.history({
        channel: channel_id,
        latest: message_id,
        limit: 1,
        inclusive: true,
      });

      messages = [
        { role: "system", content: DEFAULT_SYSTEM_CONTENT },
        { role: "user", content: result.messages[0].text },
      ];
    } catch (e) {
      // If the Assistant is not in the channel it's being asked about,
      // have it join the channel and then retry the API call
      if (e.data.error === "not_in_channel") {
        await client.conversations.join({ channel: channel_id });
        const result = await client.conversations.history({
          channel: channel_id,
          latest: message_id,
          limit: 1,
          inclusive: true,
        });

        messages = [
          { role: "system", content: DEFAULT_SYSTEM_CONTENT },
          { role: "user", content: result.messages[0].text },
        ];
      } else {
        console.error(e);
      }
    }

    console.log({ message_id, channel_id, messages });

    const chatCompletion = await hfClient.chatCompletion({
      model: "Qwen/Qwen2.5-Coder-32B-Instruct",
      messages,
      max_tokens: 2000,
    });

    await complete({
      outputs: {
        message: convertMarkdownToSlack(
          chatCompletion.choices[0].message.content,
        ),
      },
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
