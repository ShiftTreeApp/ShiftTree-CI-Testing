/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect } from "react";

import { useApi } from "@/client";
import { useLocation, useNavigate } from "react-router";

function useAuthInner() {
  const api = useApi();

  const { mutateAsync: submitLogin } = api.useMutation("post", "/login");

  return {
    async login({
      email,
      password,
    }: {
      email: string;
      password: string;
    }): Promise<void> {
      const { accessToken } = await submitLogin({
        body: { email, password },
      });
      localStorage.setItem("accessToken", accessToken);
      console.log("Logged in");
    },

    logout() {
      localStorage.removeItem("accessToken");
      console.log("Logged out");
    },

    isLoggedIn() {
      return localStorage.getItem("accessToken") !== null;
    },
  };
}

export type Auth = ReturnType<typeof useAuthInner>;

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider(props: { children: React.ReactNode }) {
  const auth = useAuthInner();

  return (
    <AuthContext.Provider value={auth}>{props.children}</AuthContext.Provider>
  );
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (auth === null) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return auth;
}

export function Authenticated(props: { children: React.ReactNode }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!auth.isLoggedIn()) {
      navigate(`/login?from=${encodeURIComponent(location.pathname)}`);
    }
  });

  return <>{props.children}</>;
}