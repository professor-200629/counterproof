import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";

export default function NotFound() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight text-fg">Page not found</h1>
      <EmptyState
        title="There is nothing at this address."
        description="The link may be wrong, or the challenge, evaluation or evidence it pointed to does not exist on this backend."
        action={
          <>
            <ButtonLink href="/challenges" variant="primary">
              Browse challenges
            </ButtonLink>
            <ButtonLink href="/">Overview</ButtonLink>
          </>
        }
      />
    </div>
  );
}
