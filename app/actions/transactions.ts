// app/actions/transactions.ts
"use server";

import { getServerSession } from "@/app/lib/auth-service";
import {
  listAdminTransactions,
  type AdminTransactionRow,
  type AdminTransactionListParams,
} from "@/app/lib/admin-transactions-service";

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

async function requireAdmin() {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");
  if (!session.roles?.includes("Admin")) throw new Error("Not authorized");
  return session;
}

export async function getAdminTransactions(
  params: AdminTransactionListParams = {}
): Promise<ActionResult<{ rows: AdminTransactionRow[]; total: number }>> {
  try {
    await requireAdmin();
    const { rows, total } = await listAdminTransactions(params);
    return { success: true, data: { rows, total } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get transactions",
    };
  }
}
