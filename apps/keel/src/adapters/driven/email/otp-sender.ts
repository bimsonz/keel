import { CODE_SECONDS, type OtpSender } from "../better-auth/auth.ts";

/** What a sign-in code's email says: the code and how long it holds, nothing else. */
export function codeText(otp: string): string {
  return `Your Keel code is ${otp}. It expires in ${CODE_SECONDS / 60} minutes.`;
}

/**
 * Sends each code in a plain text email from `from` through Email Service's
 * binding. A refused send is logged by its error code alone, never its
 * message (which may hold the address), and thrown on.
 */
export function emailOtpSender(email: SendEmail, from: string): OtpSender {
  return async ({ to, otp }) => {
    try {
      await email.send({
        to,
        from: { email: from, name: "Keel" },
        subject: "Your Keel code",
        text: codeText(otp),
      });
    } catch (error) {
      const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
      const refused =
        typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
      console.error(JSON.stringify({ ops: "email-code", refused }));
      throw error;
    }
  };
}
