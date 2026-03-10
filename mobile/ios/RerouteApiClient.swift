import CoreLocation
import Foundation

struct RerouteOption: Decodable {
  let id: String
  let distanceMeters: Int
  let durationSeconds: Int
  let recommended: Bool
  let intersectsAvoidZone: Bool
}

private struct RerouteResponse: Decodable {
  let ok: Bool
  let routes: [RerouteOption]
}

final class RerouteApiClient {
  private let baseURL: URL
  private let session: URLSession

  init(baseURL: URL, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.session = session
  }

  func requestAlternatives(
    origin: CLLocationCoordinate2D,
    destination: CLLocationCoordinate2D,
    suggestion: AmbulanceAlertEvent.RerouteSuggestion,
    completion: @escaping (Result<[RerouteOption], Error>) -> Void
  ) {
    let url = baseURL.appending(path: "reroute-options")
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    let payload: [String: Any] = [
      "origin": ["lat": origin.latitude, "lng": origin.longitude],
      "destination": ["lat": destination.latitude, "lng": destination.longitude],
      "avoidPoint": ["lat": suggestion.avoidPoint.lat, "lng": suggestion.avoidPoint.lng],
      "avoidRadiusMeters": suggestion.avoidRadiusMeters,
      "alternativeCount": 3
    ]

    do {
      request.httpBody = try JSONSerialization.data(withJSONObject: payload)
    } catch {
      completion(.failure(error))
      return
    }

    session.dataTask(with: request) { data, _, error in
      if let error {
        completion(.failure(error))
        return
      }

      guard let data else {
        completion(.failure(NSError(domain: "RerouteApi", code: -1)))
        return
      }

      do {
        let decoded = try JSONDecoder().decode(RerouteResponse.self, from: data)
        completion(.success(decoded.routes))
      } catch {
        completion(.failure(error))
      }
    }.resume()
  }
}

