"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { UserPlus, Mail, Clock, X, Users, Crown, Wrench, Ellipsis } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function getInitials(firstName?: string | null, lastName?: string | null, email?: string): string {
  if (firstName && lastName) return `${firstName[0]}${lastName[0]}`.toUpperCase();
  if (firstName) return firstName.slice(0, 2).toUpperCase();
  if (email) return email.slice(0, 2).toUpperCase();
  return "??";
}

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getRoleBadgeClass(role: string) {
  if (role === "owner" || role === "shop_owner") return "bg-yellow-50 text-yellow-700 border-yellow-200";
  return "bg-gray-50 text-gray-600 border-gray-200";
}

function getRoleLabel(role: string): string {
  if (role === "owner" || role === "shop_owner") return "Shop Owner";
  if (role === "shop_mechanic" || role === "mechanic") return "Mechanic";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function RoleIcon({ role }: { role: string }) {
  if (role === "owner" || role === "shop_owner") return <Crown className="w-3.5 h-3.5" />;
  return <Wrench className="w-3.5 h-3.5" />;
}

export default function TeamPage() {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState<"shop_mechanic" | "shop_owner">("shop_mechanic");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState(false);
  const [sending, setSending] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [changingRoleFor, setChangingRoleFor] = useState<{ shopUserId: Id<"shop_users">; currentRole: string } | null>(null);
  const [newRole, setNewRole] = useState<string>("");

  const { user: clerkUser } = useUser();

  const myShops = useQuery(api.shops.getMyShops);
  const shopId = myShops?.[0]?._id as Id<"shops"> | undefined;

  const teamMembers = useQuery(
    api.invitations.getTeamMembers,
    shopId ? { shopId } : "skip"
  );
  const invitations = useQuery(
    api.invitations.getByShop,
    shopId ? { shopId } : "skip"
  );
  const revokeInvitation = useMutation(api.invitations.revoke);
  const removeMember = useMutation(api.invitations.removeMember);
  const updateMemberRole = useMutation(api.invitations.updateMemberRole);

  const pendingInvitations = invitations?.filter((inv) => inv.status === "pending") ?? [];

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!shopId) return;
    setInviteError(null);
    setInviteSuccess(false);
    setSending(true);

    try {
      const res = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          role,
          shopId,
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          title: title.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setInviteError(data.error || "Failed to send invitation.");
      } else {
        if (data.token) console.log("Invite token:", data.token);
        setInviteSuccess(true);
        setEmail("");
        setFirstName("");
        setLastName("");
        setTitle("");
        setTimeout(() => setInviteSuccess(false), 4000);
      }
    } catch {
      setInviteError("Failed to send invitation. Please try again.");
    } finally {
      setSending(false);
    }
  }

  async function handleRevoke(invitationId: Id<"shop_invitations">) {
    setRevoking(invitationId);
    try {
      await revokeInvitation({ invitationId });
    } finally {
      setRevoking(null);
    }
  }

  async function handleRemoveMember(shopUserId: Id<"shop_users">) {
    await removeMember({ shopUserId });
  }

  async function handleChangeRole(shopUserId: Id<"shop_users">, role: string) {
    await updateMemberRole({ shopUserId, role });
    setChangingRoleFor(null);
  }

  const inputClass =
    "w-full px-3.5 py-2.5 rounded-lg border border-border text-foreground text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow bg-white";

  if (myShops === undefined) {
    return (
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Team</h1>
        <p className="text-gray-600 mb-8">Manage your mechanics and team members.</p>
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <p className="text-sm text-gray-400">Loading…</p>
        </div>
      </div>
    );
  }

  if (!shopId) {
    return (
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Team</h1>
        <p className="text-gray-600 mb-8">Manage your mechanics and team members.</p>
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <p className="text-gray-500">Set up your shop first before managing your team.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Team</h1>
        <p className="text-gray-600">Manage your mechanics and team members.</p>
      </div>

      {/* Invite Form */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center gap-2 mb-5">
          <UserPlus className="w-5 h-5 text-primary" />
          <h2 className="text-base font-semibold text-gray-900">Invite a Team Member</h2>
        </div>
        <form onSubmit={handleInvite} noValidate className="space-y-4">
          {/* Mechanic profile fields — creates a mechanics record on submit */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                First Name
              </label>
              <input
                type="text"
                placeholder="Jane"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Last Name
              </label>
              <input
                type="text"
                placeholder="Smith"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Title <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <input
              type="text"
              placeholder="Master Mechanic, ASE Certified…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Email Address <span className="text-red-500">*</span>
              </label>
              <input
                type="email"
                required
                placeholder="mechanic@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setInviteError(null);
                }}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Role
              </label>
              <Select
                selectedKey={role}
                onSelectionChange={(key) => setRole(key as "shop_mechanic" | "shop_owner")}
              >
                <SelectTrigger className="bg-white h-[42px] rounded-lg border-border text-sm px-3.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopover>
                  <SelectListBox>
                    <SelectItem id="shop_mechanic" textValue="Mechanic">
                      <span className="flex items-center gap-2">
                        <Wrench className="w-3.5 h-3.5 text-gray-500" />
                        Mechanic
                      </span>
                    </SelectItem>
                    <SelectItem id="shop_owner" textValue="Shop Owner">
                      <span className="flex items-center gap-2">
                        <Crown className="w-3.5 h-3.5 text-yellow-600" />
                        Shop Owner
                      </span>
                    </SelectItem>
                  </SelectListBox>
                </SelectPopover>
              </Select>
            </div>
          </div>

          {inviteError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {inviteError}
            </div>
          )}
          {inviteSuccess && (
            <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
              Invitation sent successfully.
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={sending || !email.trim()}
              className="px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? "Sending…" : "Send Invitation"}
            </button>
          </div>
        </form>
      </div>

      {/* Team Members */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center gap-2 mb-5">
          <Users className="w-5 h-5 text-primary" />
          <h2 className="text-base font-semibold text-gray-900">Team Members</h2>
          {teamMembers && (
            <span className="ml-auto text-xs text-muted-foreground">
              {teamMembers.length} member{teamMembers.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {teamMembers === undefined ? (
          <p className="text-sm text-gray-400 text-center py-4">Loading…</p>
        ) : teamMembers.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">No team members yet.</p>
        ) : (
          <div className="space-y-2">
            {[...teamMembers].sort((a, b) => {
              const aIsMe = a.user.clerkUserId === clerkUser?.id ? -1 : 1;
              const bIsMe = b.user.clerkUserId === clerkUser?.id ? -1 : 1;
              return aIsMe - bIsMe;
            }).map((member) => {
              const isCurrentUser = member.user.clerkUserId === clerkUser?.id;
              const isChangingRole = changingRoleFor?.shopUserId === member._id;
              return (
                <div
                  key={member._id}
                  className="flex items-center gap-3 p-3 rounded-lg bg-muted/40"
                >
                  <div className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-xs font-semibold text-accent-foreground shrink-0 overflow-hidden">
                    {member.user.profile_photo_url ? (
                      <img
                        src={member.user.profile_photo_url}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      getInitials(member.user.first_name, member.user.last_name, member.user.email)
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {member.user.first_name && member.user.last_name
                        ? `${member.user.first_name} ${member.user.last_name}`
                        : member.user.email}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">{member.user.email}</p>
                  </div>

                  {isChangingRole ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <select
                        autoFocus
                        defaultValue={changingRoleFor.currentRole}
                        onChange={(e) => setNewRole(e.target.value)}
                        className="text-xs border border-border rounded-md px-2 py-1 bg-white text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="shop_mechanic">Mechanic</option>
                        <option value="shop_owner">Shop Owner</option>
                      </select>
                      <button
                        onClick={() => handleChangeRole(member._id as Id<"shop_users">, newRole || changingRoleFor.currentRole)}
                        className="text-xs px-2 py-1 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setChangingRoleFor(null)}
                        className="text-xs px-2 py-1 rounded-md border border-border text-foreground hover:bg-muted transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border ${getRoleBadgeClass(member.role)}`}
                    >
                      <RoleIcon role={member.role} />
                      {getRoleLabel(member.role)}
                    </span>
                  )}

                  {!isChangingRole && (
                    isCurrentUser ? (
                      <div className="h-8 w-8 shrink-0" />
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="rounded-full shadow-none shrink-0 h-8 w-8"
                            aria-label="Member options"
                          >
                            <Ellipsis size={16} strokeWidth={2} aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => {
                              setNewRole(member.role);
                              setChangingRoleFor({ shopUserId: member._id as Id<"shop_users">, currentRole: member.role });
                            }}
                          >
                            Change Role
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive focus:bg-destructive/10"
                            onSelect={() => handleRemoveMember(member._id as Id<"shop_users">)}
                          >
                            Remove Member
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pending Invitations */}
      {pendingInvitations.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center gap-2 mb-5">
            <Mail className="w-5 h-5 text-primary" />
            <h2 className="text-base font-semibold text-gray-900">Pending Invitations</h2>
            <span className="ml-auto text-xs text-muted-foreground">
              {pendingInvitations.length} pending
            </span>
          </div>
          <div className="space-y-2">
            {pendingInvitations.map((inv) => (
              <div
                key={inv._id}
                className="flex items-center gap-3 p-3 rounded-lg bg-muted/40"
              >
                <div className="w-9 h-9 rounded-full bg-accent flex items-center justify-center shrink-0">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{inv.email}</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <Clock className="w-3 h-3 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">
                      Sent {getTimeAgo(inv.created_at)}
                    </p>
                  </div>
                </div>
                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border shrink-0 ${getRoleBadgeClass(inv.role)}`}
                >
                  <RoleIcon role={inv.role} />
                  {getRoleLabel(inv.role)}
                </span>
                <button
                  onClick={() => handleRevoke(inv._id as Id<"shop_invitations">)}
                  disabled={revoking === inv._id}
                  title="Revoke invitation"
                  className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50 shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
