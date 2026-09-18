"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { useUser } from "@clerk/nextjs";
import type { Id } from "@/convex/_generated/dataModel";
import ConfirmationDialog from "@/components/confirmation-dialog";
import RemoveConfirmationDialog from "@/components/remove-confirmation-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { drawerSelectTriggerClassName } from "@/components/drawer-panel-styles";
import { removeTeamMember } from "@/lib/remove-team-member";
import { sendTeamInvite } from "@/lib/send-team-invite";
import {
  Camera,
  Check,
  Ellipsis,
  Loader2,
  Mail,
  Pencil,
  RotateCw,
  Trash2,
  User,
  UserPlus,
  Users,
  Warehouse,
  X,
} from "lucide-react";

type MechanicRow = {
  _id: string;
  firstName: string;
  lastName: string;
  title: string;
  email: string;
  entityType: "mechanic" | "bay";
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

type TeamMemberRow = {
  _id: Id<"shop_users">;
  role?: string;
  mechanic_id?: Id<"mechanics"> | null;
  user: {
    clerkUserId?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    profile_photo_url?: string | null;
  };
};

type InvitationRow = {
  _id: Id<"shop_invitations">;
  email: string;
  role: string;
  status: string;
  mechanic_id?: Id<"mechanics"> | null;
};

type MemberForm = {
  role: "shop_mechanic" | "shop_owner" | "front_desk";
  mechanicId: string | null;
  entityType: "mechanic" | "bay";
  firstName: string;
  lastName: string;
  title: string;
  email: string;
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
const acceptOnBehalfMutation = makeFunctionReference<"mutation">("invitations:acceptOnBehalf");

const ROLE_OPTIONS = [
  { value: "shop_mechanic", label: "Mechanic" },
  { value: "shop_owner", label: "Shop Owner" },
  { value: "front_desk", label: "Front Desk" },
] as const;

/** First + last, trim-safe for entries with no last name (bays, or a mechanic saved without one). */
function formatMechanicName(firstName: string, lastName: string): string {
  return [firstName, lastName].filter((part) => part.trim()).join(" ");
}

function getRoleLabel(role?: string | null): string {
  if (role === "owner" || role === "shop_owner") return "Shop Owner";
  if (role === "shop_mechanic" || role === "mechanic") return "Mechanic";
  if (role === "front_desk") return "Front Desk";
  return role ? role.replace(/_/g, " ") : "Team Member";
}

function getPortalStatusMeta(status: MechanicRow["portalStatus"]) {
  if (status === "active") {
    return {
      label: "Portal active",
      className: "border-success/20 bg-success/10 text-success",
    };
  }
  if (status === "invite_sent") {
    return {
      label: "Invite sent",
      className: "border-primary/15 bg-primary/10 text-primary",
    };
  }
  if (status === "invite_expired") {
    return {
      label: "Invite expired",
      className: "border-destructive/15 bg-destructive/10 text-destructive",
    };
  }
  if (status === "invite_revoked") {
    return {
      label: "Invite revoked",
      className: "border-border bg-muted text-muted-foreground",
    };
  }
  return {
    label: "Not invited",
    className: "border-border bg-muted text-muted-foreground",
  };
}

function PersonAvatar({
  imageUrl,
  name,
  isBay = false,
}: {
  imageUrl?: string | null;
  name: string;
  isBay?: boolean;
}) {
  return (
    <Avatar className="h-11 w-11 shrink-0 border border-border bg-card">
      {imageUrl ? <AvatarImage src={imageUrl} alt={name} className="object-cover" /> : null}
      <AvatarFallback className="bg-muted text-muted-foreground">
        {isBay ? <Warehouse className="h-5 w-5" /> : <User className="h-5 w-5" />}
      </AvatarFallback>
    </Avatar>
  );
}

function getRowName(member: TeamMemberRow) {
  if (member.user.first_name && member.user.last_name) {
    return `${member.user.first_name} ${member.user.last_name}`;
  }
  return member.user.email || "Team member";
}

function getFormSubmitLabel(
  form: MemberForm,
  submitting: boolean,
  willInviteEditedMechanic = false
) {
  if (submitting) {
    if (form.role === "shop_mechanic") {
      return form.mechanicId
        ? willInviteEditedMechanic
          ? "Saving and inviting..."
          : "Saving..."
        : form.email.trim()
        ? "Saving and inviting..."
        : "Saving...";
    }
    return "Sending...";
  }

  if (form.role === "shop_mechanic") {
    const entityLabel = form.entityType === "bay" ? "bay" : "mechanic";
    if (form.mechanicId)
      return willInviteEditedMechanic ? `Save and invite ${entityLabel}` : `Save ${entityLabel}`;
    return form.email.trim() ? `Save and invite ${entityLabel}` : `Save ${entityLabel}`;
  }

  return `Invite ${getRoleLabel(form.role).toLowerCase()}`;
}

function RoleSelect({
  selectedRole,
  onSelectionChange,
  disabled = false,
  triggerClassName,
}: {
  selectedRole: string;
  onSelectionChange: (role: string) => void;
  disabled?: boolean;
  triggerClassName?: string;
}) {
  return (
    <Select
      selectedKey={selectedRole}
      onSelectionChange={(key) => onSelectionChange(String(key))}
      isDisabled={disabled}
    >
      <SelectTrigger className={triggerClassName ?? drawerSelectTriggerClassName} aria-label="Role">
        <SelectValue />
      </SelectTrigger>
      <SelectPopover placement="bottom start">
        <SelectListBox shouldFocusWrap>
          {ROLE_OPTIONS.map((role) => (
            <SelectItem key={role.value} id={role.value} textValue={role.label}>
              {role.label}
            </SelectItem>
          ))}
        </SelectListBox>
      </SelectPopover>
    </Select>
  );
}

const inputClass =
  "w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring";
const labelClass = "mb-1.5 block text-sm font-medium text-foreground";

function memberFormFromMechanic(mechanic: MechanicRow): MemberForm {
  return {
    role: "shop_mechanic",
    mechanicId: mechanic._id,
    entityType: mechanic.entityType,
    firstName: mechanic.firstName,
    lastName: mechanic.lastName,
    title: mechanic.title,
    email: mechanic.email,
  };
}

/** Whether saving this edit will also (re)send a portal invite — only for a mechanic that isn't already active. */
function computeWillInvite(form: MemberForm, mechanics: MechanicRow[] | undefined): boolean {
  if (form.role !== "shop_mechanic" || !form.mechanicId || !form.email.trim()) return false;
  const mechanic = mechanics?.find((m) => m._id === form.mechanicId);
  return mechanic?.portalStatus !== "active";
}

/** Shared team-member form body — rendered in the top "Add to Your Team" card and in the edit modal. */
function MemberFormFields({
  form,
  onFieldChange,
  onRoleChange,
  onEntityTypeChange,
  showEntityTabs,
  onSubmit,
  submitting,
  error,
  success,
  willInvite,
  emailInputRef,
  onCancel,
  cancelLabel = "Cancel",
}: {
  form: MemberForm;
  onFieldChange: (patch: Partial<MemberForm>) => void;
  onRoleChange: (role: MemberForm["role"]) => void;
  onEntityTypeChange: (entityType: MemberForm["entityType"]) => void;
  showEntityTabs: boolean;
  onSubmit: (event: React.FormEvent) => void;
  submitting: boolean;
  error: string | null;
  success: string | null;
  willInvite: boolean;
  emailInputRef?: React.Ref<HTMLInputElement>;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  return (
    <>
      {showEntityTabs && (
        <div
          role="tablist"
          aria-label="What are you adding?"
          className="mb-5 inline-flex w-full max-w-sm gap-1 rounded-xl bg-muted p-1 sm:w-auto"
        >
          <button
            type="button"
            role="tab"
            aria-selected={form.entityType === "mechanic"}
            onClick={() => onEntityTypeChange("mechanic")}
            className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              form.entityType === "mechanic"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <UserPlus className="h-4 w-4" />
            Add Mechanic
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={form.entityType === "bay"}
            onClick={() => onEntityTypeChange("bay")}
            className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              form.entityType === "bay"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Warehouse className="h-4 w-4" />
            Add Bay
          </button>
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4">
        {form.entityType === "bay" ? (
          <>
            <div>
              <label className={labelClass}>Bay Name</label>
              <input
                value={form.firstName}
                onChange={(event) => onFieldChange({ firstName: event.target.value })}
                className={inputClass}
                placeholder="Bay 1"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Name it however your shop refers to it — Bay 1, Outside Bay, Heavy Lifting Bay.
              </p>
            </div>

            <div>
              <label className={labelClass}>Email</label>
              <input
                ref={emailInputRef}
                type="email"
                value={form.email}
                onChange={(event) => onFieldChange({ email: event.target.value })}
                className={inputClass}
                placeholder="name@example.com"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Email is optional. Leave it blank to save the bay without portal access — staff can
                sign in with the shop login to manage it instead.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelClass}>Role</label>
                <RoleSelect
                  selectedRole={form.role}
                  onSelectionChange={(role) => onRoleChange(role as MemberForm["role"])}
                  disabled={form.mechanicId !== null}
                  triggerClassName={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Title</label>
                <input
                  value={form.title}
                  onChange={(event) => onFieldChange({ title: event.target.value })}
                  className={inputClass}
                  placeholder={
                    form.role === "shop_mechanic"
                      ? "Master Mechanic"
                      : form.role === "front_desk"
                      ? "Service Advisor"
                      : "Partner"
                  }
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelClass}>First Name</label>
                <input
                  value={form.firstName}
                  onChange={(event) => onFieldChange({ firstName: event.target.value })}
                  className={inputClass}
                  placeholder="Jane"
                />
              </div>
              <div>
                <label className={labelClass}>Last Name (optional)</label>
                <input
                  value={form.lastName}
                  onChange={(event) => onFieldChange({ lastName: event.target.value })}
                  className={inputClass}
                  placeholder="Smith"
                />
              </div>
            </div>

            <div>
              <label className={labelClass}>Email</label>
              <input
                ref={emailInputRef}
                type="email"
                value={form.email}
                onChange={(event) => onFieldChange({ email: event.target.value })}
                className={inputClass}
                placeholder="name@example.com"
              />
              <div className="mt-2 min-h-5">
                {form.role === "shop_mechanic" && (
                  <p className="text-xs text-muted-foreground">
                    Email is optional. Leave it blank to save the mechanic profile without portal access.
                  </p>
                )}
              </div>
              {form.mechanicId && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Mechanic profile edits stay under the mechanic role. Use the member actions below if
                  you need to change portal access after the profile is linked.
                </p>
              )}
            </div>
          </>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/15 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-lg border border-success/15 bg-success/10 px-4 py-3 text-sm text-success">
            {success}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="submit"
            disabled={submitting || (form.role !== "shop_mechanic" && !form.email.trim())}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {getFormSubmitLabel(form, submitting, willInvite)}
          </button>
        </div>
      </form>
    </>
  );
}

export default function TeamPage() {
  const [memberForm, setMemberForm] = useState<MemberForm>({
    role: "shop_mechanic",
    mechanicId: null,
    entityType: "mechanic",
    firstName: "",
    lastName: "",
    title: "",
    email: "",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [submittingForm, setSubmittingForm] = useState(false);
  const [editForm, setEditForm] = useState<MemberForm | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [editFocusEmail, setEditFocusEmail] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directorySuccess, setDirectorySuccess] = useState<string | null>(null);
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
  const [changingRoleFor, setChangingRoleFor] = useState<{
    shopUserId: Id<"shop_users">;
    currentRole: string;
  } | null>(null);
  const [newRole, setNewRole] = useState<string>("");
  const editEmailInputRef = useRef<HTMLInputElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const { user: clerkUser } = useUser();

  const myShops = useTypedQuery<Array<{ _id: Id<"shops"> }>>(getMyShopsQuery);
  const shopId = myShops?.[0]?._id as Id<"shops"> | undefined;
  const teamMembers = useTypedQuery<TeamMemberRow[]>(
    getTeamMembersQuery,
    shopId ? { shopId } : "skip"
  );
  const invitations = useTypedQuery<InvitationRow[]>(
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
    entityType?: "mechanic" | "bay";
  }) => Promise<Id<"mechanics">>;
  const updateMechanic = useMutation(updateManagedMechanicMutation) as (args: {
    mechanicId: Id<"mechanics">;
    firstName: string;
    lastName: string;
    title?: string;
    email?: string;
    entityType?: "mechanic" | "bay";
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
  const acceptOnBehalf = useMutation(acceptOnBehalfMutation) as (args: {
    invitationId: Id<"shop_invitations">;
  }) => Promise<{ alreadyAccepted: boolean; shopId: Id<"shops"> }>;

  // Focus (and select) the email field when the edit modal is opened from the "invite, needs email" path.
  useEffect(() => {
    if (!editForm || !editFocusEmail) return;
    const timeout = window.setTimeout(() => {
      editEmailInputRef.current?.focus({ preventScroll: true });
      editEmailInputRef.current?.select();
    }, 50);
    return () => window.clearTimeout(timeout);
  }, [editForm, editFocusEmail]);

  // While the edit modal is open, close on Escape and lock body scroll behind the backdrop.
  useEffect(() => {
    if (!editForm) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setEditForm(null);
        setEditError(null);
        setEditFocusEmail(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [editForm]);

  const membersByMechanicId = new Map<string, TeamMemberRow>();
  for (const member of teamMembers ?? []) {
    if (member.mechanic_id) {
      membersByMechanicId.set(String(member.mechanic_id), member);
    }
  }

  const mechanicIds = new Set((mechanics ?? []).map((mechanic) => mechanic._id));
  const standaloneMembers = (teamMembers ?? [])
    .filter((member) => !member.mechanic_id || !mechanicIds.has(String(member.mechanic_id)))
    .sort((a, b) => {
      const aIsCurrent = a.user.clerkUserId === clerkUser?.id ? -1 : 1;
      const bIsCurrent = b.user.clerkUserId === clerkUser?.id ? -1 : 1;
      return aIsCurrent - bIsCurrent;
    });
  const pendingNonMechanicInvitations = (invitations ?? []).filter(
    (invitation) => invitation.status === "pending" && !invitation.mechanic_id
  );
  const totalDirectoryCount =
    (mechanics?.length ?? 0) +
    standaloneMembers.length +
    pendingNonMechanicInvitations.length;
  const badgeClass = "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium";
  const directoryNameClass = "truncate text-sm font-semibold text-foreground";

  function clearFormMessages() {
    setFormError(null);
    setFormSuccess(null);
  }

  function clearDirectoryMessages() {
    setDirectoryError(null);
    setDirectorySuccess(null);
  }

  function handleFormRoleChange(role: MemberForm["role"]) {
    clearFormMessages();
    setMemberForm((prev) => ({
      role,
      mechanicId: role === "shop_mechanic" ? prev.mechanicId : null,
      entityType: prev.entityType,
      firstName: prev.firstName,
      lastName: prev.lastName,
      title: prev.title,
      email: prev.email,
    }));
  }

  function handleEntityTypeChange(entityType: MemberForm["entityType"]) {
    clearFormMessages();
    setMemberForm({
      role: "shop_mechanic",
      mechanicId: null,
      entityType,
      firstName: "",
      lastName: "",
      title: "",
      email: "",
    });
  }

  function resetForm(role: MemberForm["role"] = "shop_mechanic") {
    setMemberForm({
      role,
      mechanicId: null,
      entityType: "mechanic",
      firstName: "",
      lastName: "",
      title: "",
      email: "",
    });
  }

  function closeEditModal() {
    setEditForm(null);
    setEditError(null);
    setEditFocusEmail(false);
  }

  /**
   * Shared create/update/invite flow used by both the "Add to Your Team" card and the edit modal.
   * `cb` routes messages and completion to whichever surface triggered the submit.
   */
  async function runMemberSubmit(
    form: MemberForm,
    cb: {
      setError: (message: string | null) => void;
      setSuccess: (message: string) => void;
      setSubmitting: (value: boolean) => void;
      onDone: () => void;
    }
  ) {
    if (!shopId) return;

    cb.setError(null);
    cb.setSubmitting(true);

    try {
      if (form.role === "shop_mechanic") {
        const isBay = form.entityType === "bay";
        const entityLabel = isBay ? "Bay" : "Mechanic";

        if (!form.firstName.trim()) {
          cb.setError(isBay ? "Enter a bay name." : "Enter a first name for the mechanic.");
          return;
        }

        if (form.mechanicId) {
          const mechanicToInvite = mechanics?.find((m) => m._id === form.mechanicId) ?? null;

          await updateMechanic({
            mechanicId: form.mechanicId as Id<"mechanics">,
            firstName: form.firstName.trim(),
            lastName: form.lastName.trim(),
            title: form.title.trim() || undefined,
            email: form.email.trim() || undefined,
            entityType: form.entityType,
          });

          if (form.email.trim() && mechanicToInvite?.portalStatus !== "active") {
            if (
              mechanicToInvite?.pendingInvitationId &&
              (mechanicToInvite.portalStatus === "invite_sent" ||
                mechanicToInvite.portalStatus === "invite_expired")
            ) {
              await removeTeamMember({ invitationId: mechanicToInvite.pendingInvitationId });
            }

            const result = await sendTeamInvite({
              email: form.email.trim(),
              role: "shop_mechanic",
              shopId,
              mechanicId: form.mechanicId,
              origin: window.location.origin,
            });

            if (!result.ok) {
              cb.setError(`${entityLabel} profile updated, but the invitation failed: ${result.error}`);
              return;
            }

            cb.setSuccess(`${entityLabel} profile updated and invited.`);
          } else {
            cb.setSuccess(`${entityLabel} profile updated.`);
          }

          cb.onDone();
          return;
        }

        const mechanicId = await createMechanic({
          shopId,
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          title: form.title.trim() || undefined,
          email: form.email.trim() || undefined,
          entityType: form.entityType,
        });

        if (form.email.trim()) {
          const result = await sendTeamInvite({
            email: form.email.trim(),
            role: "shop_mechanic",
            shopId,
            mechanicId,
            origin: window.location.origin,
          });
          if (!result.ok) {
            cb.setError(`${entityLabel} saved, but the invitation failed: ${result.error}`);
            return;
          }
          cb.setSuccess(`${entityLabel} saved and invited.`);
        } else {
          cb.setSuccess(`${entityLabel} profile saved.`);
        }

        cb.onDone();
        return;
      }

      if (!form.email.trim()) {
        cb.setError(`Enter an email address for the ${getRoleLabel(form.role).toLowerCase()}.`);
        return;
      }

      const result = await sendTeamInvite({
        email: form.email.trim(),
        role: form.role,
        shopId,
        firstName: form.firstName.trim() || undefined,
        lastName: form.lastName.trim() || undefined,
        title: form.title.trim() || undefined,
        origin: window.location.origin,
      });

      if (!result.ok) {
        cb.setError(result.error);
        return;
      }

      cb.setSuccess(`${getRoleLabel(form.role)} invitation sent.`);
      cb.onDone();
    } catch (error) {
      cb.setError(error instanceof Error ? error.message : "Failed to save team member.");
    } finally {
      cb.setSubmitting(false);
    }
  }

  async function handleAddSubmit(event: React.FormEvent) {
    event.preventDefault();
    clearFormMessages();
    await runMemberSubmit(memberForm, {
      setError: setFormError,
      setSuccess: setFormSuccess,
      setSubmitting: setSubmittingForm,
      onDone: () => resetForm(memberForm.role),
    });
  }

  async function handleEditSubmit(event: React.FormEvent) {
    event.preventDefault();
    const form = editForm;
    if (!form) return;
    clearDirectoryMessages();
    await runMemberSubmit(form, {
      setError: setEditError,
      setSuccess: (message) => setDirectorySuccess(message),
      setSubmitting: setSubmittingEdit,
      onDone: () => closeEditModal(),
    });
  }

  function editMechanic(mechanic: MechanicRow) {
    setEditError(null);
    setEditFocusEmail(false);
    setEditForm(memberFormFromMechanic(mechanic));
  }

  async function inviteMechanic(mechanic: MechanicRow, revokeExisting = false) {
    if (!shopId || !mechanic.email.trim()) {
      // No email on file yet — open the edit modal focused on the email field so the owner can add one.
      setEditError("Add an email address before inviting this mechanic.");
      setEditFocusEmail(true);
      setEditForm(memberFormFromMechanic(mechanic));
      return;
    }

    clearDirectoryMessages();
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
        setDirectoryError(result.error);
        return;
      }
      setDirectorySuccess(revokeExisting ? "Invitation resent." : "Invitation sent.");
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "Failed to send invitation.");
    } finally {
      setMechanicActionId(null);
    }
  }

  async function acceptOnBehalfOf(mechanic: MechanicRow) {
    if (!mechanic.pendingInvitationId) return;
    clearDirectoryMessages();
    setMechanicActionId(mechanic._id);
    try {
      await acceptOnBehalf({
        invitationId: mechanic.pendingInvitationId as Id<"shop_invitations">,
      });
      const name = formatMechanicName(mechanic.firstName, mechanic.lastName);
      setDirectorySuccess(`Accepted on behalf of ${name}. They now appear on the schedule.`);
    } catch (error) {
      setDirectoryError(
        error instanceof Error ? error.message : "Failed to accept invitation."
      );
    } finally {
      setMechanicActionId(null);
    }
  }

  async function revokeInvite(mechanic: MechanicRow) {
    if (!mechanic.pendingInvitationId) return;
    clearDirectoryMessages();
    setMechanicActionId(mechanic._id);
    try {
      await removeTeamMember({ invitationId: mechanic.pendingInvitationId });
      setDirectorySuccess("Invitation revoked.");
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "Failed to revoke invitation.");
    } finally {
      setMechanicActionId(null);
    }
  }

  function chooseMechanicPhoto(mechanic: MechanicRow) {
    clearDirectoryMessages();
    setPendingPhotoMechanicId(mechanic._id);
    photoInputRef.current?.click();
  }

  async function handlePhotoSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const mechanicId = pendingPhotoMechanicId;
    event.target.value = "";
    if (!file || !mechanicId) return;

    clearDirectoryMessages();
    setUploadingMechanicId(mechanicId);
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
      setDirectorySuccess("Mechanic photo updated.");
    } catch (error) {
      setDirectoryError(
        error instanceof Error ? error.message : "Failed to update mechanic photo."
      );
    } finally {
      setPendingPhotoMechanicId(null);
      setUploadingMechanicId(null);
    }
  }

  async function removeMechanicPhoto(mechanic: MechanicRow) {
    clearDirectoryMessages();
    setUploadingMechanicId(mechanic._id);
    try {
      await updateMechanicPhoto({
        mechanicId: mechanic._id as Id<"mechanics">,
        profilePhotoStorageId: null,
      });
      setDirectorySuccess("Mechanic photo removed.");
    } catch (error) {
      setDirectoryError(
        error instanceof Error ? error.message : "Failed to remove mechanic photo."
      );
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
    clearDirectoryMessages();
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
      setDirectorySuccess("Mechanic removed.");
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "Failed to remove mechanic.");
    } finally {
      setMechanicActionId(null);
    }
  }

  async function handleRemoveMember(shopUserId: Id<"shop_users">) {
    clearDirectoryMessages();
    setRemovingMemberId(shopUserId);
    try {
      await removeTeamMember({ shopUserId });
      setRemoveMemberConfirm(null);
      setDirectorySuccess("Portal access removed.");
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "Failed to remove member.");
    } finally {
      setRemovingMemberId(null);
    }
  }

  async function handleChangeRole(shopUserId: Id<"shop_users">, role: string) {
    clearDirectoryMessages();
    try {
      await updateMemberRole({ shopUserId, role });
      setChangingRoleFor(null);
      setNewRole("");
      setDirectorySuccess(`Role updated to ${getRoleLabel(role)}.`);
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "Failed to update role.");
    }
  }

  async function handleRevokeStandaloneInvite(invitationId: Id<"shop_invitations">) {
    clearDirectoryMessages();
    try {
      await removeTeamMember({ invitationId });
      setDirectorySuccess("Invitation revoked.");
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "Failed to revoke invitation.");
    }
  }

  if (myShops === undefined) {
    return (
      <div className="mx-auto max-w-6xl">
        <h1 className="mb-2 text-2xl font-bold text-foreground">Team</h1>
        <div className="rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!shopId) {
    return (
      <div className="mx-auto max-w-6xl">
        <h1 className="mb-2 text-2xl font-bold text-foreground">Team</h1>
        <div className="rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
          <p className="text-muted-foreground">Set up your shop first before managing your team.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="mb-2 text-2xl font-bold text-foreground">Team</h1>
        <p className="text-muted-foreground">
          Manage mechanic profiles, bays, portal access, and shop staff from one place.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold text-foreground">Add to Your Team</h2>
        </div>

        <MemberFormFields
          form={memberForm}
          onFieldChange={(patch) => setMemberForm((prev) => ({ ...prev, ...patch }))}
          onRoleChange={handleFormRoleChange}
          onEntityTypeChange={handleEntityTypeChange}
          showEntityTabs
          onSubmit={handleAddSubmit}
          submitting={submittingForm}
          error={formError}
          success={formSuccess}
          willInvite={false}
        />
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold text-foreground">Team Directory</h2>
          <span className="ml-auto text-xs text-muted-foreground">
            {totalDirectoryCount} entries
          </span>
        </div>

        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handlePhotoSelected}
        />

        {directoryError && (
          <div className="mb-4 rounded-lg border border-destructive/15 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {directoryError}
          </div>
        )}
        {directorySuccess && (
          <div className="mb-4 rounded-lg border border-success/15 bg-success/10 px-4 py-3 text-sm text-success">
            {directorySuccess}
          </div>
        )}

        {mechanics === undefined || teamMembers === undefined || invitations === undefined ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Loading...</p>
        ) : totalDirectoryCount === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No team members yet.</p>
        ) : (
          <div className="space-y-2">
            {mechanics.map((mechanic) => {
              const isBay = mechanic.entityType === "bay";
              const fullName = formatMechanicName(mechanic.firstName, mechanic.lastName);
              const linkedMember = membersByMechanicId.get(mechanic._id) ?? null;
              const linkedRole = linkedMember?.role || "shop_mechanic";
              const linkedName = linkedMember ? getRowName(linkedMember) : fullName;
              const linkedEmail = linkedMember?.user.email || mechanic.email || "No email";
              const isCurrentUser = linkedMember?.user.clerkUserId === clerkUser?.id;
              const roleChange = changingRoleFor;
              const isChangingRole = roleChange?.shopUserId === linkedMember?._id;
              const avatarUrl = mechanic.photoUrl || linkedMember?.user.profile_photo_url || null;
              const status = getPortalStatusMeta(mechanic.portalStatus);
              const isBusy = mechanicActionId === mechanic._id || uploadingMechanicId === mechanic._id;
              const subtitle =
                mechanic.title && mechanic.title !== "Mechanic"
                  ? linkedEmail
                    ? `${mechanic.title} - ${linkedEmail}`
                    : mechanic.title
                  : linkedEmail;

              return (
                <div
                  key={mechanic._id}
                  className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-4"
                >
                  <PersonAvatar imageUrl={avatarUrl} name={fullName} isBay={isBay} />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={directoryNameClass}>{fullName}</p>
                      {mechanic.portalStatus === "not_invited" && (
                        <span className={`${badgeClass} ${status.className}`}>{status.label}</span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        {isBay ? "Bay" : getRoleLabel(linkedRole)}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm text-muted-foreground">{subtitle}</p>
                    {!isBay && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {mechanic.reviewCount > 0
                          ? `${mechanic.rating.toFixed(1)} rating - ${mechanic.reviewCount} reviews`
                          : "No reviews yet"}
                      </p>
                    )}
                    {linkedMember && linkedName !== fullName && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Portal member: {linkedName}
                      </p>
                    )}
                  </div>

                  {isChangingRole && linkedMember && roleChange ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <RoleSelect
                        selectedRole={newRole || roleChange.currentRole}
                        onSelectionChange={setNewRole}
                        triggerClassName={`min-w-40 ${drawerSelectTriggerClassName}`}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          handleChangeRole(
                            linkedMember._id,
                            newRole || roleChange.currentRole
                          )
                        }
                        className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground transition-opacity hover:opacity-90"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setChangingRoleFor(null)}
                        className="rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
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
                            {avatarUrl ? "Update photo" : "Add photo"}
                          </DropdownMenuItem>
                          {mechanic.photoUrl && (
                            <DropdownMenuItem onSelect={() => void removeMechanicPhoto(mechanic)}>
                              <X className="mr-2 h-4 w-4" />
                              Remove photo
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {mechanic.portalStatus === "not_invited" ||
                          mechanic.portalStatus === "invite_revoked" ? (
                            <DropdownMenuItem onSelect={() => void inviteMechanic(mechanic)}>
                              <Mail className="mr-2 h-4 w-4" />
                              Invite to portal
                            </DropdownMenuItem>
                          ) : null}
                          {mechanic.portalStatus === "invite_sent" ||
                          mechanic.portalStatus === "invite_expired" ? (
                            <DropdownMenuItem
                              onSelect={() => void inviteMechanic(mechanic, true)}
                            >
                              <RotateCw className="mr-2 h-4 w-4" />
                              Resend invite
                            </DropdownMenuItem>
                          ) : null}
                          {mechanic.pendingInvitationId && (
                            <DropdownMenuItem
                              onSelect={() => void acceptOnBehalfOf(mechanic)}
                            >
                              <Check className="mr-2 h-4 w-4" />
                              Mark as accepted
                            </DropdownMenuItem>
                          )}
                          {mechanic.pendingInvitationId && (
                            <DropdownMenuItem onSelect={() => void revokeInvite(mechanic)}>
                              <X className="mr-2 h-4 w-4" />
                              Revoke invite
                            </DropdownMenuItem>
                          )}
                          {linkedMember && !isCurrentUser && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() => {
                                  setNewRole(linkedRole);
                                  setChangingRoleFor({
                                    shopUserId: linkedMember._id,
                                    currentRole: linkedRole,
                                  });
                                }}
                              >
                                <Pencil className="mr-2 h-4 w-4" />
                                Change role
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                                onSelect={() =>
                                  setRemoveMemberConfirm({
                                    shopUserId: linkedMember._id,
                                    name: linkedName,
                                  })
                                }
                              >
                                <User className="mr-2 h-4 w-4" />
                                Remove portal access
                              </DropdownMenuItem>
                            </>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                            onSelect={() => requestRemoveMechanic(mechanic)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {isBay ? "Remove bay" : "Remove mechanic"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
              );
            })}

            {standaloneMembers.map((member) => {
              const isCurrentUser = member.user.clerkUserId === clerkUser?.id;
              const role = member.role || "front_desk";
              const roleChange = changingRoleFor;
              const isChangingRole = roleChange?.shopUserId === member._id;
              const displayName = getRowName(member);

              return (
                <div
                  key={member._id}
                  className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-4"
                >
                  <PersonAvatar imageUrl={member.user.profile_photo_url} name={displayName} />

                  <div className="min-w-0 flex-1">
                    <p className={directoryNameClass}>{displayName}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        {getRoleLabel(role)}
                      </span>
                      {isCurrentUser && (
                        <span className={`${badgeClass} border-border bg-muted text-muted-foreground`}>
                          You
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {member.user.email || "No email"}
                    </p>
                  </div>

                  {isChangingRole && roleChange ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <RoleSelect
                        selectedRole={newRole || roleChange.currentRole}
                        onSelectionChange={setNewRole}
                        triggerClassName={`min-w-40 ${drawerSelectTriggerClassName}`}
                      />
                      <button
                        type="button"
                        onClick={() => handleChangeRole(member._id, newRole || roleChange.currentRole)}
                        className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground transition-opacity hover:opacity-90"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setChangingRoleFor(null)}
                        className="rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : !isCurrentUser ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 shrink-0 rounded-full shadow-none"
                          aria-label="Member options"
                        >
                          <Ellipsis size={16} strokeWidth={2} aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => {
                            setNewRole(role);
                            setChangingRoleFor({
                              shopUserId: member._id,
                              currentRole: role,
                            });
                          }}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          Change role
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                          onSelect={() =>
                            setRemoveMemberConfirm({
                              shopUserId: member._id,
                              name: displayName,
                            })
                          }
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Remove member
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <div className="h-8 w-8 shrink-0" />
                  )}
                </div>
              );
            })}

            {pendingNonMechanicInvitations.map((invitation) => (
              <div
                key={invitation._id}
                className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-4"
              >
                <PersonAvatar imageUrl={null} name={invitation.email} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {invitation.email}
                    </p>
                    <span className="text-xs font-medium text-muted-foreground">
                      {getRoleLabel(invitation.role)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Waiting for acceptance.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevokeStandaloneInvite(invitation._id)}
                  title="Revoke invitation"
                  className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

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
        title={removeMechanicConfirm?.entityType === "bay" ? "Remove bay?" : "Remove mechanic?"}
        subjectName={
          removeMechanicConfirm
            ? formatMechanicName(removeMechanicConfirm.firstName, removeMechanicConfirm.lastName)
            : undefined
        }
        confirmLabel={removeMechanicConfirm?.entityType === "bay" ? "Remove bay" : "Remove mechanic"}
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
        title={blockedMechanic?.entityType === "bay" ? "Bay has active work" : "Mechanic has active work"}
        description={
          blockedMechanic
            ? `${formatMechanicName(blockedMechanic.firstName, blockedMechanic.lastName)} has ${blockedMechanic.blockingBookingCount} active booking or job. Complete or reassign the work before removing this ${blockedMechanic.entityType === "bay" ? "bay" : "mechanic"}.`
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
              <div
                key={booking._id}
                className="rounded-lg border border-border bg-muted px-3 py-2 text-sm"
              >
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

      {editForm && typeof document !== "undefined"
        ? createPortal(
            <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
              <div
                className="absolute inset-0 bg-black/20 backdrop-blur-sm"
                onClick={closeEditModal}
              />
              <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
                <div className="flex items-center justify-between gap-2 border-b border-border px-6 py-4">
                  <div className="flex items-center gap-2">
                    <Pencil className="h-5 w-5 text-primary" />
                    <h2 className="text-base font-semibold text-foreground">
                      {editForm.entityType === "bay" ? "Edit Bay" : "Edit Mechanic Profile"}
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={closeEditModal}
                    aria-label="Close"
                    className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="overflow-y-auto px-6 py-5">
                  <MemberFormFields
                    form={editForm}
                    onFieldChange={(patch) =>
                      setEditForm((prev) => (prev ? { ...prev, ...patch } : prev))
                    }
                    onRoleChange={() => {}}
                    onEntityTypeChange={() => {}}
                    showEntityTabs={false}
                    onSubmit={handleEditSubmit}
                    submitting={submittingEdit}
                    error={editError}
                    success={null}
                    willInvite={computeWillInvite(editForm, mechanics)}
                    emailInputRef={editEmailInputRef}
                    onCancel={closeEditModal}
                  />
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
