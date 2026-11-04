export interface RoleRef { id: string; code: string; name: string }
export interface UserRow {
  id: string; email: string; firstName: string; lastName: string; phone: string | null; isActive: boolean; lastLoginAt: string | null; joinedAt: string;
  branch: { id: string; code: string; name: string } | null; roles: RoleRef[];
}
export interface Role { id: string; code: string; name: string; description: string | null; isSystem: boolean; permissionCodes: string[] }
export interface Permission { id: string; code: string; description: string | null }
export interface Branch { id: string; code: string; name: string; isActive: boolean }

/** "clients.view" -> "clients": permissions are grouped by what they apply to. */
export const permissionArea = (code: string) => code.split('.')[0];
