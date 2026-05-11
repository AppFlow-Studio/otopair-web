import { redirect } from "next/navigation";

export default function CreateBookingRedirect() {
  redirect("/schedule?action=newBooking");
}
