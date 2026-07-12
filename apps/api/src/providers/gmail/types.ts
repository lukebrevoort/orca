export type GmailHeader = {
  name: string;
  value: string;
};

export type GmailMessagePartBody = {
  data?: string;
  size?: number;
  attachmentId?: string;
};

export type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
};

export type GmailLabel = {
  id: string;
  name: string;
  type?: "system" | "user";
};
