import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.castlebastion.td',
  appName: 'Castle Bastion TD',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
