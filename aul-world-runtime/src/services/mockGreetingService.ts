// A deliberately fake "external system" standing in for a future real
// service. This is the ONLY file allowed to simulate network-like latency
// or failure for the AWR-02 proof. It returns plain data only — it has no
// idea a reducer, event bus, DOM, or PixiJS even exists, and it never
// mutates anything outside its own local closure.
//
// Not Firebase, not Firestore, not an HTTP call, not a production service.

export interface GreetingServiceRequest {
  forceFailure: boolean;
}

export interface GreetingServiceResult {
  message: string;
}

const GREETINGS = [
  "Hai! Selamat datang di dunia Aul.",
  "Aul senang kamu mampir hari ini.",
  "Halo! Ada yang bisa dibantu?",
];

const SIMULATED_LATENCY_MS = 500;

export function mockGreetingService(request: GreetingServiceRequest): Promise<GreetingServiceResult> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (request.forceFailure) {
        reject(new Error("MockGreetingService: simulated failure"));
        return;
      }
      const message = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      resolve({ message });
    }, SIMULATED_LATENCY_MS);
  });
}
