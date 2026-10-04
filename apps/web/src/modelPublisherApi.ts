import { api } from "./api";

export interface ModelPublisher { id: string; name: string; enabled: boolean; endpoint: string; username?: string; password?: string; clearPassword?: boolean; hasPassword?: boolean; instancePaths: string[]; topicPrefix: string; shape: "object" | "leaves"; mode: "onChange" | "interval"; intervalMs: number; qos: 0 | 1; retain: boolean; queueLimit: number; queueBytes: number }
export interface ModelPublisherDiagnostic { id: string; state: string; lastError?: string; queuedCount: number; queuedBytes: number; delivered: number; retries: number; rejected: number; lastDeliveredAt?: string; overflowPolicy?: string; delivery?: string }
export interface ModelPublishing { revision: number; publishers: ModelPublisher[]; diagnostics: ModelPublisherDiagnostic[] }
export interface ModelPublishPreview { messages: { topic: string; payload: unknown; bytes: number }[]; total: number; truncated: boolean }
export const newModelPublisher = (): ModelPublisher => ({ id: `publisher-${crypto.randomUUID().slice(0, 8)}`, name: "Equipment publisher", enabled: false, endpoint: "mqtt://localhost:1883", instancePaths: [], topicPrefix: "sparkstudio/equipment", shape: "object", mode: "onChange", intervalMs: 1000, qos: 1, retain: false, queueLimit: 1000, queueBytes: 10485760 });
export const getModelPublishing = () => api<ModelPublishing>("/model/publishing");
export const previewModelPublishing = (publisher: ModelPublisher) => api<ModelPublishPreview>("/model/publishing/preview", "POST", { publisher });
export const saveModelPublisher = (revision: number, publisher: ModelPublisher) => api(`/model/publishing/${encodeURIComponent(publisher.id)}`, "PUT", { revision, publisher });
export const deleteModelPublisher = (revision: number, id: string) => api(`/model/publishing/${encodeURIComponent(id)}?revision=${revision}`, "DELETE");
export const testModelPublisher = (id: string) => api<{ success: boolean; message?: string }>(`/model/publishing/${encodeURIComponent(id)}/test`, "POST", {});
export const discardModelPublisherQueue = (id: string) => api<{ discarded: number }>(`/model/publishing/${encodeURIComponent(id)}/discard`, "POST", {});
