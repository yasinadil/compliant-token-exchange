import type { Metadata } from "next";
import { Inter, Work_Sans } from "next/font/google";
import { AuthProvider } from "./context/AuthContext";
import { getServerSession } from "./lib/auth-service";
import "./globals.css";


const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const workSans = Work_Sans({
  variable: "--font-work-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Compliant Token Exchange",
  description: "Wallet, exchange, and staking for the Compliant Token Exchange ecosystem.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getServerSession();
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${workSans.variable} antialiased`}
      >
        <AuthProvider initialUser={user}>{children}</AuthProvider>
      </body>
    </html>
  );
}
