import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { AuthModalProvider } from "@/contexts/AuthModalContext";
import AuthModal from "@/components/AuthModal";
import ProtectedRoute from "@/components/ProtectedRoute";
import Index from "./pages/Index";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import NotFound from "./pages/NotFound";
import ClassicEuropeRoute from "./pages/ClassicEuropeRoute";
import YoungCapitalsRoute from "./pages/YoungCapitalsRoute";
import AlternativeBackpackerRoute from "./pages/AlternativeBackpackerRoute";
import InterrailPurchase from "./pages/InterrailPurchase";
import RouteBuilder from "./pages/RouteBuilder";
import RouteCheckout from "./pages/RouteCheckout";
import TermsAndConditions from "./pages/TermsAndConditions";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import ItineraryDetail from "./pages/ItineraryDetail";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <AuthModalProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <AuthModal />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/home" element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            } />
            <Route path="/itinerario/ruta-europa-central" element={
              <ProtectedRoute>
                <ItineraryDetail />
              </ProtectedRoute>
            } />
            <Route path="/ruta/europa-clasica" element={
              <ProtectedRoute>
                <ClassicEuropeRoute />
              </ProtectedRoute>
            } />
            <Route path="/ruta/capitales-jovenes" element={
              <ProtectedRoute>
                <YoungCapitalsRoute />
              </ProtectedRoute>
            } />
            <Route path="/ruta/alternativa-mochilera" element={
              <ProtectedRoute>
                <AlternativeBackpackerRoute />
              </ProtectedRoute>
            } />
            <Route path="/comprar-interrail" element={
              <ProtectedRoute>
                <InterrailPurchase />
              </ProtectedRoute>
            } />
            <Route path="/crear-ruta" element={
              <ProtectedRoute>
                <RouteBuilder />
              </ProtectedRoute>
            } />
            <Route path="/checkout/:routeId" element={
              <ProtectedRoute>
                <RouteCheckout />
              </ProtectedRoute>
            } />
            <Route path="/terminos-y-condiciones" element={<TermsAndConditions />} />
            <Route path="/politica-de-privacidad" element={<PrivacyPolicy />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
      </AuthModalProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
