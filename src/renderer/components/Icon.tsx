export function Icon({ icon, size = 22 }: { icon?: string; size?: number }) {
  if (icon?.startsWith("beam-icon://")) {
    return <img className="icon-img" src={icon} width={size} height={size} alt="" draggable={false} />;
  }
  return (
    <span className="icon-emoji" style={{ fontSize: size * 0.82, width: size, height: size }}>
      {icon ?? "•"}
    </span>
  );
}
