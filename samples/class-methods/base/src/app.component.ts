import { GreetingService } from "./greeting.service";

export class AppComponent {
  private service = new GreetingService();

  run(): number {
    return this.service.computeTotal(2, 3);
  }
}
