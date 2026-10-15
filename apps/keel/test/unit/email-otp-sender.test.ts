import { afterEach, describe, expect, it, vi } from "vitest";
import { emailOtpSender } from "../../src/adapters/driven/email/otp-sender.ts";

/** Email Service's binding as a test holds it: each message kept, or each refused with `refusal`. */
function binding(refusal?: Error) {
  const sent: (EmailMessage | EmailMessageBuilder)[] = [];
  const email: SendEmail = {
    send: async (message: EmailMessage | EmailMessageBuilder) => {
      if (refusal !== undefined) throw refusal;
      sent.push(message);
      return { messageId: `<${sent.length}@mail.keel.test>` };
    },
  };
  return { email, sent };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("email codes through Email Service", () => {
  it("[mail.code] sends the code in plain text, from Keel's address to the one asked for", async () => {
    const { email, sent } = binding();
    await emailOtpSender(
      email,
      "noreply@mail.keel.test",
    )({
      to: "ada@example.com",
      otp: "123456",
      type: "sign-in",
    });
    expect(sent).toEqual([
      {
        to: "ada@example.com",
        from: { email: "noreply@mail.keel.test", name: "Keel" },
        subject: "Your Keel code",
        text: "Your Keel code is 123456. It expires in 5 minutes.",
      },
    ]);
  });

  it("[mail.refused] a refused send is thrown on, and logged by its code without the address", async () => {
    const refusal = Object.assign(new Error("ada@example.com is suppressed"), {
      code: "E_RECIPIENT_SUPPRESSED",
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = emailOtpSender(binding(refusal).email, "noreply@mail.keel.test");
    await expect(send({ to: "ada@example.com", otp: "123456", type: "sign-in" })).rejects.toBe(
      refusal,
    );
    expect(logged.mock.calls).toEqual([
      [JSON.stringify({ ops: "email-code", refused: "E_RECIPIENT_SUPPRESSED" })],
    ]);
  });
});
