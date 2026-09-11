/**
 * Top-centre warning shown while Mapping or Navigation is running and the
 * runstop is on.
 */
export default function RunstopBanner({ runstop }) {
  const { engaged, pending, release } = runstop;

  if (engaged !== true) return null;

  return (
    <div className="runstop-banner" role="alert">
      <span className="runstop-banner__pulse" aria-hidden="true" />
      <span className="runstop-banner__text">
        The robot is runstopped — it will not move.
      </span>
      <button
        type="button"
        className="btn primary sm"
        disabled={pending === 'release'}
        onClick={release}
      >
        {pending === 'release' ? (
          <>
            <span className="spinner" /> Releasing…
          </>
        ) : (
          'Release runstop'
        )}
      </button>
    </div>
  );
}
