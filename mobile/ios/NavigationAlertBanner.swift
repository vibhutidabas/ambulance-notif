import UIKit

final class NavigationAlertBanner: UIView {
  private let titleLabel = UILabel()
  private let subtitleLabel = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = UIColor.systemRed.withAlphaComponent(0.92)
    layer.cornerRadius = 14

    titleLabel.font = .preferredFont(forTextStyle: .headline)
    titleLabel.textColor = .white

    subtitleLabel.font = .preferredFont(forTextStyle: .subheadline)
    subtitleLabel.textColor = .white
    subtitleLabel.numberOfLines = 2

    let stack = UIStackView(arrangedSubviews: [titleLabel, subtitleLabel])
    stack.axis = .vertical
    stack.spacing = 4
    stack.translatesAutoresizingMaskIntoConstraints = false

    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: topAnchor, constant: 12),
      stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12)
    ])

    alpha = 0
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func show(message: String, distanceMeters: Int, severity: String) {
    titleLabel.text = severity == "critical" ? "Ambulance nearby" : "Ambulance approaching"
    subtitleLabel.text = "\(message) • \(distanceMeters)m"

    UIView.animate(withDuration: 0.15) {
      self.alpha = 1
    }
  }

  func hide() {
    UIView.animate(withDuration: 0.15) {
      self.alpha = 0
    }
  }
}

