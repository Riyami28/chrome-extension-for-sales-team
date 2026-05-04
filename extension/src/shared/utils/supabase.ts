import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: {
      getItem: (key) => new Promise((resolve) => chrome.storage.local.get(key, (r) => resolve(r[key] ?? null))),
      setItem: (key, value) => new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve)),
      removeItem: (key) => new Promise((resolve) => chrome.storage.local.remove(key, resolve)),
    },
    autoRefreshToken: true,
    persistSession: true,
  },
});
