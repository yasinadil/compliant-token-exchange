import { cookieStorage, createStorage } from "wagmi";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { base } from "@reown/appkit/networks";

export const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID || "";

export const wagmiAdapter = new WagmiAdapter({
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  projectId,
  networks: [base],
});
