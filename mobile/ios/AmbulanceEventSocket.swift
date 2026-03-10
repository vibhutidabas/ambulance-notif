import Foundation
import CoreLocation

struct AmbulanceMarkerEvent: Decodable {
  struct Position: Decodable {
    let lat: Double
    let lng: Double
    let heading: Double?
  }

  let type: String
  let ambulanceId: String
  let status: String
  let position: Position
  let distanceMeters: Int?
}

struct AmbulanceAlertEvent: Decodable {
  struct PredictedIntersection: Decodable {
    struct Point: Decodable {
      let lat: Double
      let lng: Double
    }

    let point: Point
    let ambulanceTimeToIntersectionSeconds: Int
  }

  struct RerouteSuggestion: Decodable {
    struct AvoidPoint: Decodable {
      let lat: Double
      let lng: Double
    }

    let reason: String
    let avoidPoint: AvoidPoint
    let avoidRadiusMeters: Int
    let recommendedWithinSeconds: Int
  }

  let type: String
  let ambulanceId: String
  let severity: String
  let matchType: String
  let message: String
  let distanceMeters: Int
  let timeToImpactSeconds: Int
  let predictedIntersection: PredictedIntersection?
  let rerouteSuggestion: RerouteSuggestion?
}

final class AmbulanceEventSocket: NSObject {
  private let session = URLSession(configuration: .default)
  private let decoder = JSONDecoder()
  private var task: URLSessionWebSocketTask?

  var onMarker: ((AmbulanceMarkerEvent) -> Void)?
  var onAlert: ((AmbulanceAlertEvent) -> Void)?

  func connect(baseURL: URL) {
    let socketURL = baseURL.appending(path: "ws/drivers")
    task = session.webSocketTask(with: socketURL)
    task?.resume()
    receiveNext()
  }

  func registerRoute(
    sessionId: String,
    driverId: String,
    appState: String,
    pushToken: String?,
    location: CLLocationCoordinate2D,
    heading: CLLocationDirection?,
    speedMps: CLLocationSpeed?,
    routeId: String,
    routePolyline: [CLLocationCoordinate2D]
  ) {
    let routePoints = routePolyline.map { ["lat": $0.latitude, "lng": $0.longitude] }
    var currentPosition: [String: Any] = [
      "lat": location.latitude,
      "lng": location.longitude,
      "timestamp": Int(Date().timeIntervalSince1970 * 1000)
    ]
    if let heading {
      currentPosition["heading"] = heading
    }
    if let speedMps {
      currentPosition["speedMps"] = speedMps
    }

    var payload: [String: Any] = [
      "type": "driver.register_route",
      "sessionId": sessionId,
      "driverId": driverId,
      "platform": "ios",
      "appState": appState,
      "currentPosition": currentPosition,
      "route": [
        "routeId": routeId,
        "polyline": routePoints
      ]
    ]
    if let pushToken {
      payload["pushToken"] = pushToken
    }

    send(json: payload)
  }

  func sendProgress(
    sessionId: String,
    appState: String,
    location: CLLocationCoordinate2D,
    heading: CLLocationDirection?,
    speedMps: CLLocationSpeed?
  ) {
    var currentPosition: [String: Any] = [
      "lat": location.latitude,
      "lng": location.longitude,
      "timestamp": Int(Date().timeIntervalSince1970 * 1000)
    ]
    if let heading {
      currentPosition["heading"] = heading
    }
    if let speedMps {
      currentPosition["speedMps"] = speedMps
    }

    let payload: [String: Any] = [
      "type": "driver.progress",
      "sessionId": sessionId,
      "appState": appState,
      "currentPosition": currentPosition
    ]

    send(json: payload)
  }

  private func receiveNext() {
    task?.receive { [weak self] result in
      guard let self else { return }

      if case let .success(message) = result,
         case let .string(text) = message,
         let data = text.data(using: .utf8) {
        if let marker = try? self.decoder.decode(AmbulanceMarkerEvent.self, from: data),
           marker.type == "ambulance.marker" {
          self.onMarker?(marker)
        } else if let alert = try? self.decoder.decode(AmbulanceAlertEvent.self, from: data),
                  alert.type == "ambulance.alert" {
          self.onAlert?(alert)
        }
      }

      self.receiveNext()
    }
  }

  private func send(json: [String: Any]) {
    guard
      let data = try? JSONSerialization.data(withJSONObject: json),
      let string = String(data: data, encoding: .utf8)
    else {
      return
    }

    task?.send(.string(string)) { _ in }
  }
}
