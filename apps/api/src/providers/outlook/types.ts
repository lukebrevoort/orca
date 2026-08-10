export type GraphContact = {
  emailAddress?: {
    name?: string | null;
    address?: string | null;
  };
};

export type GraphMessage = {
  id: string;
  conversationId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  receivedDateTime?: string | null;
  isRead?: boolean;
  from?: GraphContact | null;
  toRecipients?: GraphContact[];
  ccRecipients?: GraphContact[];
  bccRecipients?: GraphContact[];
  body?: { contentType?: "text" | "html" | string; content?: string | null };
  internetMessageId?: string | null;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  categories?: string[];
};
