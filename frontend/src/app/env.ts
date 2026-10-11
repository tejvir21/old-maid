export const API_URL: string = (import.meta.env["VITE_API_URL"] as string | undefined)?.replace(/\/$/, "") ?? "";
export const SOCKET_URL: string = ((import.meta.env["VITE_SOCKET_URL"] as string | undefined) ?? API_URL).replace(/\/$/, "");
