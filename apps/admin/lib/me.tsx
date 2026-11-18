"use client";

import { createContext, useContext } from "react";
import type { Me } from "./api";

export const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside the signed-in layout");
  return me;
}

export const can = (me: Me, permission: string) => me.permissions.includes(permission);

/** Lead-provider portal user (sees only their own source's data). */
export const isProvider = (me: Me) => me.platform !== null;

/** Internal staff (not tied to one organisation or source). */
export const isStaff = (me: Me) => me.platform === null && me.organisation_id === null;

/** Settings are for administrators only. */
export const canSeeSettings = (me: Me) =>
  isStaff(me) &&
  ["platforms.manage", "destinations.manage", "users.manage", "audit.read"].some((p) =>
    me.permissions.includes(p),
  );

export const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super admin",
  admin: "Administrator",
  operator: "Operator",
  analyst: "Analyst",
  compliance: "Compliance",
  org_viewer: "Organisation viewer",
  provider_viewer: "Lead source user",
};
