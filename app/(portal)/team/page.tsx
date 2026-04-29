"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { useUser } from "@clerk/nextjs";
import type { Id } from "@/convex/_generated/dataModel";
import ConfirmationDialog from "@/components/confirmation-dialog";
import RemoveConfirmationDialog from "@/components/remove-confirmation-dialog";
import { removeTeamMember } from "@/lib/remove-team-member";
import { sendTeamInvite } from "@/lib/send-team-invite";
import {
  Camera,
  Crown,
  Ellipsis,
  Loader2,
  Mail,
  Pencil,
  RotateCw,
  Trash2,
  UserPlus,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type MechanicRow = {
  _id: string;
  firstName: string;
  lastName: string;
  title: string;
  email: string;
  rating: number;
  reviewCount: number;
  photoUrl?: string | null;
  shopUserId: string | null;
  invitationId: string | null;
  pendingInvitationId: string | null;
  portalStatus:
    | "not_invited"
    | "invite_sent"
    | "active"
    | "invite_expired"
    | "invite_revoked";
  blockingBookings: Array<{
    _id: string;
    status: string;
    scheduledDate: string | null;
    scheduledTime: string | null;
  }>;
  blockingBookingCount: number;
};

type MechanicForm = {
  mechanicId: string | null;
  firstName: string;
  lastName: string;
  title: string;
  email: string;
};

type TeamMemberRow = {
  _id: Id<"shop_users">;
  role?: string;
  user: {
    clerkUserId?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    profile_photo_url?: string | null;
  };
};

type OwnerInvitationRow = {
  _id: Id<"shop_invitations">;
  email: string;
  role: string;
  status: string;
};

const useTypedQuery = useQuery as <T>(
  query: FunctionReference<"query">,
  args?: Record<string, unknown> | "skip"
) => T | undefined;

const getMyShopsQuery = makeFunctionReference<"query">("shops:getMyShops");
const getTeamMembersQuery = makeFunctionReference<"query">("invitations:getTeamMembers");
const getInvitationsByShopQuery = makeFunctionReference<"query">("invitations:getByShop");
const getManagedMechanicsQuery = makeFunctionReference<"query">("mechanics:getManagedByShop");
const createManagedMechanicMutation = makeFunctionReference<"mutation">("mechanics:createManaged");
const updateManagedMechanicMutation = makeFunctionReference<"mutation">("mechanics:updateManaged");
const updateManagedMechanicPhotoMutation = makeFunctionReference<"mutation">(
  "mechanics:updateManagedPhoto"
);
const deactivateManagedMechanicMutation = makeFunctionReference<"mutation">(
  "mechanics:deactivateManaged"
);
const generateUploadUrlMutation = makeFunctionReference<"mutation">("users:generateUploadUrl");
const updateMemberRoleMutation = makeFunctionReference<"mutation">("invitations:updateMemberRole");

function getInitials(firstName?: string | null, lastName?: string | null, email?: string): string {
  if (firstName && lastName) return `${firstName[0]}${lastName[0]}`.toUpperCase();
  if (firstName) return firstName.slice(0, 2).toUpperCase();
  if (email) return email.slice(0, 2).toUpperCase();
  return "ME";
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

function getPortalStatusMeta(status: MechanicRow["portalStatus"]) {
  if (status === "active") {
    return {
      label: "Active on portal",
      className: "border-green-200 bg-green-50 text-green-700",
    };
  }
  if (status === "invite_sent") {
    return {
      label: "Invite sent",
      className: "border-amber-200 bg-amber-50 text-amber-700",
    };
  }
  if (status === "invite_expired") {
    return {
      label: "Invite expired",
      className: "border-red-200 bg-red-50 text-red-700",
    };
  }
  if (status === "invite_revoked") {
    return {
      label: "Invite revoked",
      className: "border-gray-200 bg-gray-50 text-gray-600",
    };
  }
  return {
    label: "Not invited",
    className: "border-gray-200 bg-gray-50 text-gray-600",
  };
}

function RoleIcon({ role }: { role: string }) {
  if (role === "owner" || role === "shop_owner") return <Crown className="h-3.5 w-3.5" />;
  return <Wrench className="h-3.5 w-3.5" />;
}

function MechanicAvatar({ mechanic }: { mechanic: MechanicRow }) {
  return (
    <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full bg-accent text-xs font-semibold text-accent-foreground">
      {mechanic.photoUrl ? (
        <img
          src={mechanic.photoUrl}
          alt={`${mechanic.firstName} ${mechanic.lastName}`}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          {getInitials(mechanic.firstName, mechanic.lastName, mechanic.email)}
        </div>
      )}
    </div>
  );
}

export default function TeamPage() {
  const [ownerInvite, setOwnerInvite] = useState({
    email: "",
    firstName: "",
    lastName: "",
    title: "",
  });
  const [ownerInviteError, setOwnerInviteError] = useState<string | null>(null);
  const [ownerInviteSuccess, setOwnerInviteSuccess] = useState(false);
  const [sendingOwnerInvite, setSendingOwnerInvite] = useState(false);
  const [mechanicForm, setMechanicForm] = useState<MechanicForm>({
    mechanicId: null,
    firstName: "",
    lastName: "",
    title: "",
    email: "",
  });
  const [mechanicError, setMechanicError] = useState<string | null>(null);
  const [mechanicSuccess, setMechanicSuccess] = useState<string | null>(null);
  const [savingMechanic, setSavingMechanic] = useState(false);
  const [mechanicActionId, setMechanicActionId] = useState<string | null>(null);
  const [uploadingMechanicId, setUploadingMechanicId] = useState<string | null>(null);
  const [pendingPhotoMechanicId, setPendingPhotoMechanicId] = useState<string | null>(null);
  const [removeMechanicConfirm, setRemoveMechanicConfirm] = useState<MechanicRow | null>(null);
  const [blockedMechanic, setBlockedMechanic] = useState<MechanicRow | null>(null);
  const [removeMemberConfirm, setRemoveMemberConfirm] = useState<{
    shopUserId: Id<"shop_users">;
    name: string;
  } | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [changingRoleFor, setChangingRoleFor] = useState<{ shopUserId: Id<"shop_users">; currentRole: string } | null>(null);
  const [newRole, setNewRole] = useState<string>("");
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const { user: clerkUser } = useUser();

  const myShops = useTypedQuery<Array<{ _id: Id<"shops"> }>>(getMyShopsQuery);
  const shopId = myShops?.[0]?._id as Id<"shops"> | undefined;
  const teamMembers = useTypedQuery<TeamMemberRow[]>(
    getTeamMembersQuery,
    shopId ? { shopId } : "skip"
  );
  const invitations = useTypedQuery<OwnerInvitationRow[]>(
    getInvitationsByShopQuery,
    shopId ? { shopId } : "skip"
  );
  const mechanics = useTypedQuery<MechanicRow[]>(
    getManagedMechanicsQuery,
    shopId ? { shopId } : "skip"
  );
  const createMechanic = useMutation(createManagedMechanicMutation) as (args: {
    shopId: Id<"shops">;
    firstName: string;
    lastName: string;
    title?: string;
    email?: string;
  }) => Promise<Id<"mechanics">>;
  const updateMechanic = useMutation(updateManagedMechanicMutation) as (args: {
    mechanicId: Id<"mechanics">;
    firstName: string;
    lastName: string;
    title?: string;
    email?: string;
  }) => Promise<Id<"mechanics">>;
  const updateMechanicPhoto = useMutation(updateManagedMechanicPhotoMutation) as (args: {
    mechanicId: Id<"mechanics">;
    profilePhotoStorageId: string | null;
  }) => Promise<{ mechanicId: Id<"mechanics">; photoUrl: string | null }>;
  const deactivateMechanic = useMutation(deactivateManagedMechanicMutation) as (args: {
    mechanicId: Id<"mechanics">;
  }) => Promise<Id<"mechanics">>;
  const generateUploadUrl = useMutation(generateUploadUrlMutation) as () => Promise<string>;
  const updateMemberRole = useMutation(updateMemberRoleMutation) as (args: {
    shopUserId: Id<"shop_users">;
    role: string;
  }) => Promise<void>;

  const ownerInvitations = (invitations ?? []).filter(
    (inv) => inv.status === "pending" && inv.role === "shop_owner"
  );

  const inputClass =
    "w-full rounded-lg border border-border bg-white px-3.5 py-2.5 text-sm text-foreground placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-ring";
  const labelClass = "mb-1.5 block text-sm font-medium text-gray-700";

  async function handleOwnerInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!shopId) return;
    setOwnerInviteError(null);
    setOwnerInviteSuccess(false);
    setSendingOwnerInvite(true);

    try {
      const result = await sendTeamInvite({
        email: ownerInvite.email.trim(),
        role: "shop_owner",
        shopId,
        firstName: ownerInvite.firstName.trim() || undefined,
        lastName: ownerInvite.lastName.trim() || undefined,
        title: ownerInvite.title.trim() || undefined,
        origin: window.location.origin,
      });

      if (!result.ok) {
        setOwnerInviteError(result.error);
        return;
      }

      setOwnerInvite({ email: "", firstName: "", lastName: "", title: "" });
      setOwnerInviteSuccess(true);
      setTimeout(() => setOwnerInviteSuccess(false), 4000);
    } catch {
      setOwnerInviteError("Failed to send invitation. Please try again.");
    } finally {
      setSendingOwnerInvite(false);
    }
  }

  async function handleSaveMechanic(e: React.FormEvent) {
    e.preventDefault();
    if (!shopId) return;
    setMechanicError(null);
    setMechanicSuccess(null);

    if (!mechanicForm.firstName.trim() || !mechanicForm.lastName.trim()) {
      setMechanicError("Enter both a first and last name for the mechanic.");
      return;
    }

    setSavingMechanic(true);
    try {
      if (mechanicForm.mechanicId) {
        await updateMechanic({
          mechanicId: mechanicForm.mechanicId as Id<"mechanics">,
          firstName: mechanicForm.firstName,
          lastName: mechanicForm.lastName,
          title: mechanicForm.title || undefined,
          email: mechanicForm.email || undefined,
        });
        setMechanicSuccess("Mechanic profile updated.");
      } else {
        await createMechanic({
          shopId,
          firstName: mechanicForm.firstName,
          lastName: mechanicForm.lastName,
          title: mechanicForm.title || undefined,
          email: mechanicForm.email || undefined,
        });
        setMechanicSuccess("Mechanic profile saved.");
      }
      setMechanicForm({ mechanicId: null, firstName: "", lastName: "", title: "", email: "" });
    } catch (error) {
      setMechanicError(error instanceof Error ? error.message : "Failed to save mechanic.");
    } finally {
      setSavingMechanic(false);
    }
  }

  function editMechanic(mechanic: MechanicRow) {
    setMechanicError(null);
    setMechanicSuccess(null);
    setMechanicForm({
      mechanicId: mechanic._id,
      firstName: mechanic.firstName,
      lastName: mechanic.lastName,
      title: mechanic.title,
      email: mechanic.email,
    });
  }

  async function inviteMechanic(mechanic: MechanicRow, revokeExisting = false) {
    if (!shopId || !mechanic.email.trim()) {
      setMechanicError("Add an email address before inviting this mechanic.");
      return;
    }

    setMechanicError(null);
    setMechanicSuccess(null);
    setMechanicActionId(mechanic._id);
    try {
      if (revokeExisting && mechanic.pendingInvitationId) {
        await removeTeamMember({ invitationId: mechanic.pendingInvitationId });
      }

      const result = await sendTeamInvite({
        email: mechanic.email.trim(),
        role: "shop_mechanic",
        shopId,
        mechanicId: mechanic._id,
        origin: window.location.origin,
      });
      if (!result.ok) {
        setMechanicError(result.error);
        return;
      }
      setMechanicSuccess(revokeExisting ? "Invitation resent." : "Invitation sent.");
    } catch (error) {
      setMechanicError(error instanceof Error ? error.message : "Failed to send invitation.");
    } finally {
      setMechanicActionId(null);
    }
  }

  async function revokeInvite(mechanic: MechanicRow) {
    if (!mechanic.pendingInvitationId) return;
    setMechanicActionId(mechanic._id);
    setMechanicError(null);
    setMechanicSuccess(null);
    try {
      await removeTeamMember({ invitationId: mechanic.pendingInvitationId });
      setMechanicSuccess("Invitation revoked.");
    } catch (error) {
      setMechanicError(error instanceof Error ? error.message : "Failed to revoke invitation.");
    } finally {
      setMechanicActionId(null);
    }
  }

  function chooseMechanicPhoto(mechanic: MechanicRow) {
    setPendingPhotoMechanicId(mechanic._id);
    photoInputRef.current?.click();
  }

  async function handlePhotoSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const mechanicId = pendingPhotoMechanicId;
    event.target.value = "";
    if (!file || !mechanicId) return;

    setUploadingMechanicId(mechanicId);
    setMechanicError(null);
    setMechanicSuccess(null);
    try {
      const uploadUrl = await generateUploadUrl();
      const uploadResult = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!uploadResult.ok) throw new Error("Failed to upload the image file.");
      const { storageId } = (await uploadResult.json()) as { storageId?: string };
      if (!storageId) throw new Error("Upload did not return a storage id.");

      await updateMechanicPhoto({
        mechanicId: mechanicId as Id<"mechanics">,
        profilePhotoStorageId: storageId,
      });
      setMechanicSuccess("Mechanic photo updated.");
    } catch (error) {
      setMechanicError(error instanceof Error ? error.message : "Failed to update mechanic photo.");
    } finally {
      setPendingPhotoMechanicId(null);
      setUploadingMechanicId(null);
    }
  }

  async function removeMechanicPhoto(mechanic: MechanicRow) {
    setUploadingMechanicId(mechanic._id);
    setMechanicError(null);
    setMechanicSuccess(null);
    try {
      await updateMechanicPhoto({
        mechanicId: mechanic._id as Id<"mechanics">,
        profilePhotoStorageId: null,
      });
      setMechanicSuccess("Mechanic photo removed.");
    } catch (error) {
      setMechanicError(error instanceof Error ? error.message : "Failed to remove mechanic photo.");
    } finally {
      setUploadingMechanicId(null);
    }
  }

  function requestRemoveMechanic(mechanic: MechanicRow) {
    if (mechanic.blockingBookingCount > 0) {
      setBlockedMechanic(mechanic);
      return;
    }
    setRemoveMechanicConfirm(mechanic);
  }

  async function removeMechanic(mechanic: MechanicRow) {
    setMechanicActionId(mechanic._id);
    try {
      if (mechanic.shopUserId) {
        await removeTeamMember({ shopUserId: mechanic.shopUserId });
      }
      if (mechanic.pendingInvitationId) {
        await removeTeamMember({ invitationId: mechanic.pendingInvitationId });
      }
      await deactivateMechanic({ mechanicId: mechanic._id as Id<"mechanics"> });
      setRemoveMechanicConfirm(null);
      setMechanicSuccess("Mechanic removed.");
    } catch (error) {
      setMechanicError(error instanceof Error ? error.message : "Failed to remove mechanic.");
    } finally {
      setMechanicActionId(null);
    }
  }

  async function handleRemoveMember(shopUserId: Id<"shop_users">) {
    setRemovingMemberId(shopUserId);
    try {
      await removeTeamMember({ shopUserId });
      setRemoveMemberConfirm(null);
    } finally {
      setRemovingMemberId(null);
    }
  }

  async function handleChangeRole(shopUserId: Id<"shop_users">, role: string) {
    await updateMemberRole({ shopUserId, role });
    setChangingRoleFor(null);
  }

  if (myShops === undefined) {
    return (
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-2 text-2xl font-bold text-gray-900">Team</h1>
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
          <p className="text-sm text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (!shopId) {
    return (
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-2 text-2xl font-bold text-gray-900">Team</h1>
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
          <p className="text-gray-500">Set up your shop first before managing your team.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="mb-2 text-2xl font-bold text-gray-900">Team</h1>
        <p className="text-gray-600">Manage mechanic profiles, portal access, and shop owners.</p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="mb-5 flex items-center gap-2">
          <Wrench className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold text-gray-900">
            {mechanicForm.mechanicId ? "Edit Mechanic" : "Add Mechanic"}
          </h2>
        </div>

        <form onSubmit={handleSaveMechanic} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>First Name</label>
              <input
                value={mechanicForm.firstName}
                onChange={(event) =>
                  setMechanicForm((prev) => ({ ...prev, firstName: event.target.value }))
                }
                className={inputClass}
                placeholder="Jane"
              />
            </div>
            <div>
              <label className={labelClass}>Last Name</label>
              <input
                value={mechanicForm.lastName}
                onChange={(event) =>
                  setMechanicForm((prev) => ({ ...prev, lastName: event.target.value }))
                }
                className={inputClass}
                placeholder="Smith"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Title</label>
              <input
                value={mechanicForm.title}
                onChange={(event) =>
                  setMechanicForm((prev) => ({ ...prev, title: event.target.value }))
                }
                className={inputClass}
                placeholder="Master Mechanic"
              />
            </div>
            <div>
              <label className={labelClass}>Email</label>
              <input
                type="email"
                value={mechanicForm.email}
                onChange={(event) =>
                  setMechanicForm((prev) => ({ ...prev, email: event.target.value }))
                }
                className={inputClass}
                placeholder="mechanic@example.com"
              />
            </div>
          </div>

          {mechanicError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {mechanicError}
            </div>
          )}
          {mechanicSuccess && (
            <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              {mechanicSuccess}
            </div>
          )}

          <div className="flex justify-end gap-2">
            {mechanicForm.mechanicId && (
              <button
                type="button"
                onClick={() =>
                  setMechanicForm({ mechanicId: null, firstName: "", lastName: "", title: "", email: "" })
                }
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={savingMechanic}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {savingMechanic && <Loader2 className="h-4 w-4 animate-spin" />}
              {mechanicForm.mechanicId ? "Save mechanic" : "Add mechanic"}
            </button>
          </div>
        </form>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="mb-5 flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold text-gray-900">Mechanics</h2>
          {mechanics && (
            <span className="ml-auto text-xs text-muted-foreground">
              {mechanics.length} mechanic{mechanics.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handlePhotoSelected}
        />

        {mechanics === undefined ? (
          <p className="py-4 text-center text-sm text-gray-400">Loading...</p>
        ) : mechanics.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-500">No mechanics yet.</p>
        ) : (
          <div className="space-y-2">
            {mechanics.map((mechanic) => {
              const status = getPortalStatusMeta(mechanic.portalStatus);
              const isBusy = mechanicActionId === mechanic._id || uploadingMechanicId === mechanic._id;
              return (
                <div key={mechanic._id} className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                  <MechanicAvatar mechanic={mechanic} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-gray-900">
                        {mechanic.firstName} {mechanic.lastName}
                      </p>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${status.className}`}>
                        {status.label}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {mechanic.title || "Mechanic"}
                      {mechanic.email ? ` - ${mechanic.email}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {mechanic.reviewCount > 0
                        ? `${mechanic.rating.toFixed(1)} rating - ${mechanic.reviewCount} reviews`
                        : "No reviews yet"}
                    </p>
                  </div>

                  {isBusy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 shrink-0 rounded-full shadow-none"
                        aria-label="Mechanic options"
                      >
                        <Ellipsis size={16} strokeWidth={2} aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => editMechanic(mechanic)}>
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit profile
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => chooseMechanicPhoto(mechanic)}>
                        <Camera className="mr-2 h-4 w-4" />
                        {mechanic.photoUrl ? "Update photo" : "Add photo"}
                      </DropdownMenuItem>
                      {mechanic.photoUrl && (
                        <DropdownMenuItem onSelect={() => removeMechanicPhoto(mechanic)}>
                          <X className="mr-2 h-4 w-4" />
                          Remove photo
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      {mechanic.portalStatus === "not_invited" || mechanic.portalStatus === "invite_revoked" ? (
                        <DropdownMenuItem onSelect={() => void inviteMechanic(mechanic)}>
                          <Mail className="mr-2 h-4 w-4" />
                          Invite to portal
                        </DropdownMenuItem>
                      ) : null}
                      {mechanic.portalStatus === "invite_sent" || mechanic.portalStatus === "invite_expired" ? (
                        <DropdownMenuItem onSelect={() => void inviteMechanic(mechanic, true)}>
                          <RotateCw className="mr-2 h-4 w-4" />
                          Resend invite
                        </DropdownMenuItem>
                      ) : null}
                      {mechanic.pendingInvitationId && (
                        <DropdownMenuItem onSelect={() => void revokeInvite(mechanic)}>
                          <X className="mr-2 h-4 w-4" />
                          Revoke invite
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                        onSelect={() => requestRemoveMechanic(mechanic)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Remove mechanic
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="mb-5 flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold text-gray-900">Invite a Shop Owner</h2>
        </div>
        <form onSubmit={handleOwnerInvite} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              value={ownerInvite.firstName}
              onChange={(event) =>
                setOwnerInvite((prev) => ({ ...prev, firstName: event.target.value }))
              }
              placeholder="First name"
              className={inputClass}
            />
            <input
              value={ownerInvite.lastName}
              onChange={(event) =>
                setOwnerInvite((prev) => ({ ...prev, lastName: event.target.value }))
              }
              placeholder="Last name"
              className={inputClass}
            />
          </div>
          <input
            type="email"
            value={ownerInvite.email}
            onChange={(event) =>
              setOwnerInvite((prev) => ({ ...prev, email: event.target.value }))
            }
            placeholder="owner@example.com"
            className={inputClass}
          />
          {ownerInviteError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {ownerInviteError}
            </div>
          )}
          {ownerInviteSuccess && (
            <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              Invitation sent successfully.
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={sendingOwnerInvite || !ownerInvite.email.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {sendingOwnerInvite && <Loader2 className="h-4 w-4 animate-spin" />}
              Send owner invitation
            </button>
          </div>
        </form>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="mb-5 flex items-center gap-2">
          <Crown className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold text-gray-900">Portal Members</h2>
          {teamMembers && (
            <span className="ml-auto text-xs text-muted-foreground">
              {teamMembers.length} member{teamMembers.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {teamMembers === undefined ? (
          <p className="py-4 text-center text-sm text-gray-400">Loading...</p>
        ) : teamMembers.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-500">No portal members yet.</p>
        ) : (
          <div className="space-y-2">
            {[...teamMembers]
              .sort((a, b) => {
                const aIsMe = a.user.clerkUserId === clerkUser?.id ? -1 : 1;
                const bIsMe = b.user.clerkUserId === clerkUser?.id ? -1 : 1;
                return aIsMe - bIsMe;
              })
              .map((member) => {
                const isCurrentUser = member.user.clerkUserId === clerkUser?.id;
                const roleChange = changingRoleFor;
                const isChangingRole = roleChange?.shopUserId === member._id;
                const displayName =
                  member.user.first_name && member.user.last_name
                    ? `${member.user.first_name} ${member.user.last_name}`
                    : member.user.email || "Team member";

                return (
                  <div key={member._id} className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                    <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-accent text-xs font-semibold text-accent-foreground">
                      {member.user.profile_photo_url ? (
                        <img src={member.user.profile_photo_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center">
                          {getInitials(member.user.first_name, member.user.last_name, member.user.email)}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-gray-900">{displayName}</p>
                      <p className="truncate text-xs text-muted-foreground">{member.user.email}</p>
                    </div>

                    {isChangingRole && roleChange ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <select
                          autoFocus
                          defaultValue={roleChange.currentRole}
                          onChange={(event) => setNewRole(event.target.value)}
                          className="rounded-md border border-border bg-white px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                          <option value="shop_mechanic">Mechanic</option>
                          <option value="shop_owner">Shop Owner</option>
                        </select>
                        <button
                          onClick={() =>
                            handleChangeRole(
                              member._id as Id<"shop_users">,
                              newRole || roleChange.currentRole
                            )
                          }
                          className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground transition-opacity hover:opacity-90"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setChangingRoleFor(null)}
                          className="rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${getRoleBadgeClass(member.role || "shop_mechanic")}`}>
                        <RoleIcon role={member.role || "shop_mechanic"} />
                        {getRoleLabel(member.role || "shop_mechanic")}
                      </span>
                    )}

                    {!isChangingRole && (
                      isCurrentUser ? (
                        <div className="h-8 w-8 shrink-0" />
                      ) : (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 rounded-full shadow-none">
                              <Ellipsis size={16} strokeWidth={2} aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onSelect={() => {
                                setNewRole(member.role || "shop_mechanic");
                                setChangingRoleFor({
                                  shopUserId: member._id as Id<"shop_users">,
                                  currentRole: member.role || "shop_mechanic",
                                });
                              }}
                            >
                              Change Role
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                              onSelect={() =>
                                setRemoveMemberConfirm({
                                  shopUserId: member._id as Id<"shop_users">,
                                  name: displayName,
                                })
                              }
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

      {ownerInvitations.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <div className="mb-5 flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold text-gray-900">Pending Owner Invitations</h2>
          </div>
          <div className="space-y-2">
            {ownerInvitations.map((inv) => (
              <div key={inv._id} className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-900">{inv.email}</p>
                  <p className="text-xs text-muted-foreground">Pending invitation</p>
                </div>
                <button
                  onClick={() => removeTeamMember({ invitationId: inv._id })}
                  title="Revoke invitation"
                  className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <RemoveConfirmationDialog
        open={removeMemberConfirm !== null}
        title="Remove member?"
        subjectName={removeMemberConfirm?.name}
        confirmLabel="Remove member"
        isSubmitting={!!removingMemberId}
        submittingLabel="Removing..."
        onClose={() => setRemoveMemberConfirm(null)}
        onConfirm={() => {
          if (!removeMemberConfirm) return;
          void handleRemoveMember(removeMemberConfirm.shopUserId);
        }}
      />

      <RemoveConfirmationDialog
        open={removeMechanicConfirm !== null}
        title="Remove mechanic?"
        subjectName={
          removeMechanicConfirm
            ? `${removeMechanicConfirm.firstName} ${removeMechanicConfirm.lastName}`
            : undefined
        }
        confirmLabel="Remove mechanic"
        isSubmitting={mechanicActionId === removeMechanicConfirm?._id}
        submittingLabel="Removing..."
        onClose={() => setRemoveMechanicConfirm(null)}
        onConfirm={() => {
          if (!removeMechanicConfirm) return;
          void removeMechanic(removeMechanicConfirm);
        }}
      />

      <ConfirmationDialog
        open={blockedMechanic !== null}
        title="Mechanic has active work"
        description={
          blockedMechanic
            ? `${blockedMechanic.firstName} ${blockedMechanic.lastName} has ${blockedMechanic.blockingBookingCount} active booking or job. Complete or reassign the work before removing this mechanic.`
            : undefined
        }
        onClose={() => setBlockedMechanic(null)}
        primaryAction={{
          label: "Close",
          onAction: () => setBlockedMechanic(null),
          variant: "primary",
        }}
      >
        {blockedMechanic && blockedMechanic.blockingBookings.length > 0 && (
          <div className="space-y-2">
            {blockedMechanic.blockingBookings.map((booking) => (
              <div key={booking._id} className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                <span className="font-medium text-foreground">{booking.status}</span>
                <span className="text-muted-foreground">
                  {booking.scheduledDate ? ` - ${booking.scheduledDate}` : ""}
                  {booking.scheduledTime ? ` at ${booking.scheduledTime}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </ConfirmationDialog>
    </div>
  );
}
