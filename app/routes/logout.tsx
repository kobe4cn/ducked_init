import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { logout } from "~/.server/auth";

export async function loader() {
  throw redirect("/");
}

export async function action({ request }: Route.ActionArgs) {
  throw redirect("/login", { headers: { "Set-Cookie": await logout(request) } });
}
