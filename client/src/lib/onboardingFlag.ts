import { LazyStore } from '@tauri-apps/plugin-store';

const store = new LazyStore('settings.json');
const KEY = 'onboarded';

export async function isOnboarded(): Promise<boolean> {
  const value = await store.get<boolean>(KEY);
  return value === true;
}

export async function markOnboarded(): Promise<void> {
  await store.set(KEY, true);
  await store.save();
}
